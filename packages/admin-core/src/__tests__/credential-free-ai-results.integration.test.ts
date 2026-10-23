// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #971 — a credential an AI-requested change produces never reaches
 * the AI or an MCP client, end to end against real Postgres.
 *
 * Every credential-producing / credential-rotating gated tool runs through
 * the surface the AI really uses:
 *
 *  - the Live Edit chat turn (SDK approval pause → Approve → resume), where
 *    the executor's output becomes the tool result the model reads next and
 *    lands in chat_messages.response_messages, replayed every later turn;
 *  - caelo_chat (`mcp.send_chat`, chat token): the external agent's own turn
 *    resumes after the operator's decision and returns its reply;
 *  - Power-MCP (`mcp.execute_tool`, admin token): the proposal queues, the
 *    Owner approves in the admin, the agent reads `mcp.get_approval_outcome`.
 *
 * Then everything the AI side can read is scanned: the model's prompts, the
 * transcript, the MCP replies, audit summaries, pending-row payloads and
 * previews. Two checks per credential: the value the approver collects
 * (`credentials.issue`) appears in none of it, and no AI-visible tool result
 * carries a credential at all (a new user's password hash verifies against
 * none of its strings; no `mcp_…` bearer appears anywhere).
 *
 * `SCENARIOS` must cover every tool that declares `producesCredential` plus
 * the rotation tools — the first test fails when a new one is added without
 * a scenario here.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { deriveStagingCredential, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { FilteredTool } from "../ai/chat-runner/tool-catalogue.js";
import type { ClientEvent } from "../ai/chat-runner.js";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { configureMcpBridge, resolveMcpToken } from "../ops/security/mcp_tokens.js";
import { verifyPassword } from "../password.js";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

process.env.CAELO_AGENT_CANCEL_POLL_MS = "50";

const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000971a1",
  actorKind: "human",
  requestId: "t971-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t971-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t971-system",
};
const GATE_SECRET = "t971-gate-secret";
const STAGING_ENV = { CAELO_PROVIDER: "gcp-firebase", CAELO_STAGING_GATE_SECRET: GATE_SECRET };
const MCP_BEARER = /mcp_[0-9a-f]{64}/;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const tools = createDefaultToolRegistry();
/** How the chat-runner dispatches a read tool: AI actor, the Owner present. */
let toolCtx: ToolContext;

/** The scripted model: each step replays the next queued script. */
class ScriptedProvider extends FixtureProvider {
  readonly steps: ProviderEvent[][] = [];
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    return (
      this.steps.shift() ?? [
        { kind: "text-delta", text: "Done." },
        { kind: "usage", inputTokens: 2, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ]
    );
  }
  /** Next step: call one (gated) tool. */
  ask(name: string, args: Record<string, unknown>, callId: string): void {
    this.steps.push([
      { kind: "tool-call", id: callId, name, arguments: args },
      { kind: "usage", inputTokens: 5, outputTokens: 4, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ]);
  }
}
let provider: ScriptedProvider;

async function withSql<T>(fn: (tx: SQL) => Promise<T>, kind = "system"): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL caelo.actor_kind = '${kind}'`);
      return await fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function drain(stream: AsyncIterable<ClientEvent>): Promise<ClientEvent[]> {
  const events: ClientEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

function liveEdit(
  chatSessionId: string,
  input: { content: string } | { resume: { approvalId: string; approved: boolean } },
): Promise<ClientEvent[]> {
  return drain(
    runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: AI,
        humanCtx: OWNER,
        agentRunSource: "live_edit",
        operatorInitiated: true,
      },
      "resume" in input
        ? { chatSessionId, chips: [], attachments: [], resumeApproval: input.resume }
        : { chatSessionId, chips: [], attachments: [], content: input.content },
    ),
  );
}

async function createChat(title: string): Promise<string> {
  const r = await execute(registry, adapter, OWNER, "chat.create_session", { title });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { chatSessionId: string }).chatSessionId;
}

/** A Live Edit turn that calls `tool`, pauses, and resumes on the Owner's Approve. */
async function approvedLiveEditCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ chatSessionId: string; callId: string; events: ClientEvent[] }> {
  const chatSessionId = await createChat(`t971 ${tool}`);
  const callId = `t971-${crypto.randomUUID().slice(0, 8)}`;
  provider.ask(tool, args, callId);
  const paused = await liveEdit(chatSessionId, { content: `Please run ${tool}.` });
  const req = paused.find((e) => e.kind === "tool-approval-request");
  if (req?.kind !== "tool-approval-request") {
    throw new Error(`turn did not pause on an approval: ${JSON.stringify(paused)}`);
  }
  const resumed = await liveEdit(chatSessionId, {
    resume: { approvalId: req.approvalId, approved: true },
  });
  expect(resumed.some((e) => e.kind === "error")).toBe(false);
  return { chatSessionId, callId, events: [...paused, ...resumed] };
}

/** Everything the chat persisted (what the next turn replays to the model). */
async function transcript(chatSessionId: string): Promise<string> {
  return withSql(async (tx) => {
    const rows = await tx`SELECT content, tool_calls::text AS tc, response_messages::text AS rm,
                                 thinking_blocks::text AS tb
                          FROM chat_messages WHERE chat_session_id = ${chatSessionId}::uuid`;
    return JSON.stringify(rows);
  });
}

/** The tool-result parts the SDK recorded for one call — the AI's view of it. */
async function toolResultOf(chatSessionId: string, callId: string): Promise<unknown[]> {
  const rows = await withSql(
    async (tx) =>
      (await tx`SELECT response_messages FROM chat_messages
                WHERE chat_session_id = ${chatSessionId}::uuid AND response_messages IS NOT NULL`) as {
        response_messages: unknown;
      }[],
  );
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.type === "tool-result" && o.toolCallId === callId) found.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  for (const r of rows) {
    walk(
      typeof r.response_messages === "string"
        ? JSON.parse(r.response_messages)
        : r.response_messages,
    );
  }
  return found;
}

/** Audit summaries + pending-row payloads/previews — AI-adjacent stored text. */
async function storedSideChannels(): Promise<string> {
  return withSql(async (tx) => {
    const audit = await tx`SELECT operation, result_summary FROM audit_events`;
    const pending = await tx`
      SELECT payload::text AS p, preview::text AS v FROM user_pending_actions
      UNION ALL SELECT payload::text, preview::text FROM mcp_token_pending_actions
      UNION ALL SELECT payload::text, preview::text FROM owner_settings_pending_actions`;
    return JSON.stringify({ audit, pending });
  });
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    // A JSON-encoded tool output is a string too: look inside it as well.
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") return [value, ...stringLeaves(parsed)];
    } catch {
      // not JSON
    }
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

async function collect(kind: "user_temporary_password" | "mcp_token"): Promise<string> {
  const listed = await execute(registry, adapter, OWNER, "credentials.list_handoffs", { kind });
  if (!listed.ok) throw new Error(JSON.stringify(listed.error));
  const handoff = (listed.value as { handoffs: { id: string }[] }).handoffs[0];
  if (!handoff) throw new Error(`no ${kind} handoff waiting for the Owner`);
  const issued = await execute(registry, adapter, OWNER, "credentials.issue", {
    handoffId: handoff.id,
    via: "reveal",
  });
  if (!issued.ok) throw new Error(JSON.stringify(issued.error));
  const secret = (issued.value as { secret: string | null }).secret;
  if (!secret) throw new Error("issue returned no secret");
  // One time only.
  const again = await execute(registry, adapter, OWNER, "credentials.issue", {
    handoffId: handoff.id,
    via: "reveal",
  });
  expect(again.ok).toBe(false);
  return secret;
}

function expectAbsent(secret: string, visible: Record<string, string>): void {
  expect(secret.length).toBeGreaterThan(8);
  for (const [where, text] of Object.entries(visible)) {
    if (text.includes(secret)) throw new Error(`the credential reached ${where}`);
  }
}

async function passwordHashOf(email: string): Promise<string> {
  return withSql(async (tx) => {
    const rows = await tx`SELECT password_hash FROM users WHERE email = ${email}`;
    return (rows[0] as { password_hash: string }).password_hash;
  });
}

/** No string the AI saw for this call is the new user's password. */
async function expectNoPasswordIn(values: unknown[], hash: string): Promise<void> {
  const candidates = [...new Set(values.flatMap(stringLeaves))].filter(
    (s) => s.length >= 8 && s.length <= 256,
  );
  for (const c of candidates) {
    if (await verifyPassword(c, hash)) throw new Error(`an AI-visible string is the password`);
  }
}

async function withStagingEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(STAGING_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, STAGING_ENV);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function gatedTool(name: string): FilteredTool {
  const t = tools.catalogue().find((x) => x.name === name);
  if (!t) throw new Error(`${name} is not registered`);
  return t as FilteredTool;
}

async function mintToken(scope: "chat" | "admin"): Promise<string> {
  const r = await execute(registry, adapter, OWNER, "mcp_tokens.create", {
    displayName: `t971-${scope}-${crypto.randomUUID().slice(0, 6)}`,
    scope,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { plaintextToken: string }).plaintextToken;
}

const email = (tag: string) => `t971-${tag}-${crypto.randomUUID().slice(0, 6)}@example.com`;

/** One end-to-end run per credential-producing / -rotating tool. */
const SCENARIOS: Record<string, () => Promise<void>> = {
  async propose_create_user() {
    // Live Edit: the model's own next step reads the executor's output.
    const address = email("live");
    const run = await approvedLiveEditCall("propose_create_user", {
      email: address,
      displayName: "T971 Live",
      roleNames: ["editor"],
    });
    const resultParts = await toolResultOf(run.chatSessionId, run.callId);
    expect(resultParts.length).toBeGreaterThan(0);
    expect(JSON.stringify(resultParts)).toContain("/settings/users");
    await expectNoPasswordIn(resultParts, await passwordHashOf(address));

    // Power-MCP: queued over MCP, approved in the admin, outcome read back.
    const adminToken = await mintToken("admin");
    const session = await execute(registry, adapter, SYSTEM, "mcp.open_session", {
      plaintextToken: adminToken,
      newSession: true,
      title: "t971 power",
    });
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const chatSessionId = (session.value as { chatSessionId: string }).chatSessionId;
    const powerAddress = email("power");
    const queued = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "propose_create_user",
      args: { email: powerAddress, displayName: "T971 Power", roleNames: ["editor"] },
    });
    if (!queued.ok) throw new Error(JSON.stringify(queued.error));
    const proposalId = (queued.value as { approval: { proposalId: string } }).approval.proposalId;
    const applied = await execute(registry, adapter, OWNER, "users.execute_proposal", {
      proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    const outcome = await execute(registry, adapter, SYSTEM, "mcp.get_approval_outcome", {
      plaintextToken: adminToken,
      proposalId,
    });
    const pendingList = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "list_pending_proposals",
      args: {},
    });
    await expectNoPasswordIn(
      [queued.value, outcome, pendingList, applied.value],
      await passwordHashOf(powerAddress),
    );

    // The approver collects both; neither shows up anywhere the AI reads.
    const powerPassword = await collect("user_temporary_password");
    const livePassword = await collect("user_temporary_password");
    expect(await verifyPassword(livePassword, await passwordHashOf(address))).toBe(true);
    expect(await verifyPassword(powerPassword, await passwordHashOf(powerAddress))).toBe(true);
    const visible = {
      "the Live Edit events": JSON.stringify(run.events),
      "the chat transcript": await transcript(run.chatSessionId),
      "the model's prompts": JSON.stringify(provider.seenPrompts),
      "the Power-MCP replies": JSON.stringify([queued.value, outcome, pendingList]),
      "audit / pending rows": await storedSideChannels(),
    };
    expectAbsent(livePassword, visible);
    expectAbsent(powerPassword, visible);
  },

  async propose_create_mcp_token() {
    // Live Edit.
    const run = await approvedLiveEditCall("propose_create_mcp_token", {
      displayName: "t971-live-token",
    });
    const resultParts = await toolResultOf(run.chatSessionId, run.callId);
    expect(resultParts.length).toBeGreaterThan(0);
    expect(JSON.stringify(resultParts)).toContain("/settings/mcp");

    // caelo_chat: the external agent's turn pauses, the operator decides,
    // the agent's own call resumes and receives the continuation.
    const chatToken = await mintToken("chat");
    const chatSessionId = await createChat("t971 caelo_chat");
    provider.ask("propose_create_mcp_token", { displayName: "t971-chat-token" }, "t971-chat-1");
    const first = await execute(registry, adapter, SYSTEM, "mcp.send_chat", {
      plaintextToken: chatToken,
      message: "Mint a token for me.",
      chatSessionId,
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const approvalId = (first.value as { pendingApprovals: { approvalId: string }[] })
      .pendingApprovals[0]?.approvalId;
    if (!approvalId) throw new Error("caelo_chat turn did not pause on the approval");
    const decided = await execute(registry, adapter, OWNER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    expect(decided.ok).toBe(true);
    const resumed = await execute(registry, adapter, SYSTEM, "mcp.send_chat", {
      plaintextToken: chatToken,
      chatSessionId,
      resumeApprovals: true,
    });
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));

    const visible = {
      "the Live Edit events": JSON.stringify(run.events),
      "the Live Edit transcript": await transcript(run.chatSessionId),
      "the caelo_chat replies": JSON.stringify([first.value, resumed.value]),
      "the caelo_chat transcript": await transcript(chatSessionId),
      "the model's prompts": JSON.stringify(provider.seenPrompts),
      "audit / pending rows": await storedSideChannels(),
    };
    for (const [where, text] of Object.entries(visible)) {
      // The test's own bearer tokens never enter these; any match is a leak.
      if (MCP_BEARER.test(text)) throw new Error(`an MCP bearer reached ${where}`);
    }
    const chatMinted = await collect("mcp_token");
    const liveMinted = await collect("mcp_token");
    expect((await resolveMcpToken(adapter, chatMinted)).ok).toBe(true);
    expect((await resolveMcpToken(adapter, liveMinted)).ok).toBe(true);
    expectAbsent(chatMinted, visible);
    expectAbsent(liveMinted, visible);
  },

  async propose_rotate_staging_credentials() {
    await withStagingEnv(async () => {
      await withSql(async (tx) => {
        await tx`UPDATE staging_access SET basic_auth_enabled = true, basic_auth_nonce = 't971-b0',
                   header_enabled = true, header_nonce = 't971-h0' WHERE id = 1`;
        await tx`DELETE FROM owner_settings_pending_actions WHERE status = 'pending'`;
      });
      const rotated = (await attachGatedExecute(
        gatedTool("propose_rotate_staging_credentials"),
        registry,
        adapter,
        AI,
        OWNER,
      ).execute?.({ which: "both", reason: "t971: shared with a contractor who left" })) as {
        ok: boolean;
      };
      expect(rotated.ok).toBe(true);
      // The read tool, run the way the chat runs it (AI actor, Owner present).
      const read = await tools.dispatch("get_staging_access", {}, AI, toolCtx);
      const smuggled = await tools.dispatch(
        "get_staging_access",
        { includeCredentials: true },
        AI,
        toolCtx,
      );
      expect(smuggled.ok).toBe(false);
      const nonces = await withSql(
        async (tx) =>
          (await tx`SELECT basic_auth_nonce AS b, header_nonce AS h FROM staging_access WHERE id = 1`) as {
            b: string;
            h: string;
          }[],
      );
      const row = nonces[0];
      if (!row || row.b === "t971-b0" || row.h === "t971-h0") throw new Error("nothing rotated");
      const password = await deriveStagingCredential(GATE_SECRET, "basic-auth", row.b);
      const header = await deriveStagingCredential(GATE_SECRET, "header", row.h);
      // The Owner still reads them in the admin (Settings → Staging access).
      const owner = await execute(registry, adapter, OWNER, "staging_access.get", {
        includeCredentials: true,
      });
      expect(JSON.stringify(owner)).toContain(password);
      const visible = {
        "the gated tool result": JSON.stringify(rotated),
        get_staging_access: JSON.stringify([read, smuggled]),
        "audit / pending rows": await storedSideChannels(),
      };
      expectAbsent(password, visible);
      expectAbsent(header, visible);
      expect(read.content).toContain("/settings/staging");
    });
  },

  async propose_rotate_gateway_cookie_secret() {
    await withSql(async (tx) => {
      await tx`DELETE FROM owner_settings_pending_actions WHERE status = 'pending'`;
    });
    const rotated = (await attachGatedExecute(
      gatedTool("propose_rotate_gateway_cookie_secret"),
      registry,
      adapter,
      AI,
      OWNER,
    ).execute?.({ reason: "t971: the old secret may have leaked" })) as { ok: boolean };
    expect(rotated.ok).toBe(true);
    const rows = await withSql(
      async (tx) =>
        (await tx`SELECT gateway_cookie_secret AS s FROM site_settings WHERE id = 1`) as {
          s: string;
        }[],
    );
    const secret = rows[0]?.s ?? "";
    const settings = await tools.dispatch("get_gateway_settings", {}, AI, toolCtx);
    expectAbsent(secret, {
      "the gated tool result": JSON.stringify(rotated),
      get_gateway_settings: JSON.stringify(settings),
      "audit / pending rows": await storedSideChannels(),
    });
  },
};

beforeAll(async () => {
  process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = undefined;
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { registry, adapter, humanCtx: OWNER };
  await ensureRoleUser(ADMIN_URL as string, OWNER.actorId, "owner");
  provider = new ScriptedProvider();
  configureMcpBridge({ adapter, registry, resolveProvider: async () => provider });
});

afterAll(async () => {
  await withSql(async (tx) => {
    await tx`DELETE FROM credential_handoffs WHERE recipient_actor_id = ${OWNER.actorId}::uuid`;
    await tx`DELETE FROM mcp_tokens WHERE actor_id = ${OWNER.actorId}::uuid`;
    await tx`DELETE FROM users WHERE email LIKE 't971-%'`;
  });
  await adapter.close();
});

describe("credentials never reach the AI (#971)", () => {
  it("covers every credential-producing and -rotating gated tool", () => {
    const required = tools
      .catalogue()
      .filter(
        (t) =>
          (t as FilteredTool).gated?.producesCredential !== undefined || /_rotate_/.test(t.name),
      )
      .map((t) => t.name)
      .sort();
    expect(Object.keys(SCENARIOS).sort()).toEqual(required);
  });

  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(`${name}: the approver gets the credential, the AI and MCP clients never do`, run);
  }

  it("the AI can neither list nor issue a waiting credential", async () => {
    const listed = await execute(registry, adapter, AI, "credentials.list_handoffs", {});
    expect(listed.ok).toBe(false);
    const handoffs = await withSql(
      async (tx) => (await tx`SELECT id FROM credential_handoffs`) as unknown[],
      "ai",
    );
    expect(handoffs).toEqual([]);
  });
});
