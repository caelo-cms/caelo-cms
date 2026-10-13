// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — what an operator's Approve/Reject continues, and what it must
 * not start (maintainer decision, 2026-10):
 *
 *  1. The Live Edit AI's own approval (its turn paused on an SDK
 *     tool-approval-request): Approve/Reject resumes that turn — also after
 *     the operator pressed Stop. Stop still refuses auto-sent turns.
 *  2. A Power-MCP proposal: the click applies it and hands the result back
 *     to the external agent; no chat turn starts, and a Stop latch stays.
 *  3. A caelo_chat turn (chat-scoped MCP token) that paused on an approval:
 *     the MCP reply surfaces the card, the Live Edit chat lists it as the
 *     external agent's, the click only records the decision (no Live Edit
 *     turn), and the agent's own call resumes ITS turn with the outcome.
 *
 * Real gated tool (`propose_create_mcp_token` → mcp_tokens.propose_create +
 * execute_proposal) so an approval visibly applies: a token is minted.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ClientEvent } from "../ai/chat-runner.js";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

process.env.CAELO_AGENT_CANCEL_POLL_MS = "50";

/** The operator: an Owner, so their click may approve a token mint (#589). */
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000065801",
  actorKind: "human",
  requestId: "t658-owner",
};
/** An Editor: may chat, but neither approve a token mint nor manage other chats. */
const VIEWER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000065802",
  actorKind: "human",
  requestId: "t658-viewer",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t658-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t658-system",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/**
 * The scripted model, shared by every turn of a test (mcp.send_chat
 * resolves the provider per call): each model step takes the next script;
 * an empty queue answers with a short text.
 */
class ScriptedProvider extends FixtureProvider {
  readonly steps: ProviderEvent[][] = [];
  calls = 0;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.calls += 1;
    return (
      this.steps.shift() ?? [
        { kind: "text-delta", text: "Done." },
        { kind: "usage", inputTokens: 2, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ]
    );
  }
  /** Next step: call the gated token-mint tool (pauses on approval). */
  askToMint(displayName: string, callId: string): void {
    this.steps.push([
      { kind: "text-delta", text: "I'll mint that token." },
      {
        kind: "tool-call",
        id: callId,
        name: "propose_create_mcp_token",
        arguments: { displayName },
      },
      { kind: "usage", inputTokens: 5, outputTokens: 4, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ]);
  }
}

let provider: ScriptedProvider;

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM mcp_tokens WHERE actor_id IN (${OWNER.actorId}::uuid, ${VIEWER.actorId}::uuid)`;
    for (const actor of [OWNER.actorId, VIEWER.actorId]) {
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE created_by = ${actor}::uuid)`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE created_by = ${actor}::uuid)`;
      await tx`DELETE FROM chat_sessions WHERE created_by = ${actor}::uuid`;
    }
  });
}

beforeAll(async () => {
  process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = undefined;
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    for (const [id, name] of [
      [OWNER.actorId, "t658 owner"],
      [VIEWER.actorId, "t658 viewer"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${id}::uuid, 'human', ${name}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${id}::uuid, ${`${name.replace(" ", "-")}@t658.test`}, 'test-only')
               ON CONFLICT DO NOTHING`;
    }
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${OWNER.actorId}::uuid, id FROM roles WHERE name = 'owner'
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${VIEWER.actorId}::uuid, id FROM roles WHERE name = 'editor'
             ON CONFLICT DO NOTHING`;
  });
  await wipe();
  provider = new ScriptedProvider();
  configureMcpBridge({ adapter, registry, resolveProvider: async () => provider });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

async function createChat(title: string, as: ExecutionContext = OWNER): Promise<string> {
  const r = await execute(registry, adapter, as, "chat.create_session", { title });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { chatSessionId: string }).chatSessionId;
}

async function drain(stream: AsyncIterable<ClientEvent>): Promise<ClientEvent[]> {
  const events: ClientEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** A Live Edit turn exactly as the stream route drives it. */
function liveEdit(
  chatSessionId: string,
  input:
    | { content: string; operator: boolean }
    | { resume: { approvalId: string; approved: boolean } },
): Promise<ClientEvent[]> {
  const operatorInitiated = "resume" in input ? true : input.operator;
  return drain(
    runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools: createDefaultToolRegistry(),
        aiCtx: AI,
        humanCtx: OWNER,
        agentRunSource: "live_edit",
        operatorInitiated,
      },
      "resume" in input
        ? { chatSessionId, chips: [], attachments: [], resumeApproval: input.resume }
        : {
            chatSessionId,
            chips: [],
            attachments: [],
            content: input.content,
            ...(input.operator ? {} : { origin: "system" as const }),
          },
    ),
  );
}

async function stop(chatSessionId: string): Promise<void> {
  const r = await execute(registry, adapter, OWNER, "chat.cancel_agents", { chatSessionId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

async function tokensNamed(displayName: string): Promise<number> {
  return withSql(async (tx) => {
    const rows =
      await tx`SELECT count(*)::int AS c FROM mcp_tokens WHERE display_name = ${displayName}`;
    return (rows[0] as { c: number }).c;
  });
}

async function messageCount(chatSessionId: string): Promise<number> {
  return withSql(async (tx) => {
    const rows = await tx`SELECT count(*)::int AS c FROM chat_messages
                          WHERE chat_session_id = ${chatSessionId}::uuid`;
    return (rows[0] as { c: number }).c;
  });
}

async function chatStopped(chatSessionId: string): Promise<boolean> {
  return withSql(async (tx) => {
    const rows =
      await tx`SELECT agents_stopped_at FROM chat_sessions WHERE id = ${chatSessionId}::uuid`;
    return (rows[0] as { agents_stopped_at: unknown }).agents_stopped_at !== null;
  });
}

async function cards(chatSessionId: string) {
  const r = await execute(registry, adapter, OWNER, "chat.list_turn_approvals", { chatSessionId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (
    r.value as {
      approvals: { approvalId: string; source: string; status: string; approved: boolean | null }[];
    }
  ).approvals;
}

function approvalIdOf(events: ClientEvent[]): string {
  const req = events.find((e) => e.kind === "tool-approval-request");
  if (req?.kind !== "tool-approval-request") {
    throw new Error(`turn did not pause on an approval: ${JSON.stringify(events)}`);
  }
  return req.approvalId;
}

describe("case 1 — the Live Edit AI's own approval resumes its turn, also after Stop", () => {
  it("Approve after Stop resumes the paused turn and applies the change; auto turns stay refused", async () => {
    const chatSessionId = await createChat("t658 live approve");
    provider.askToMint("t658-live-approve", "call-live-1");
    const paused = await liveEdit(chatSessionId, { content: "Mint a token.", operator: true });
    const approvalId = approvalIdOf(paused);
    expect(await cards(chatSessionId)).toEqual([
      expect.objectContaining({ approvalId, source: "live_edit", status: "pending" }),
    ]);

    await stop(chatSessionId);
    // Stop still refuses everything the operator did not do themselves.
    const nudge = await liveEdit(chatSessionId, { content: "Fix round 1.", operator: false });
    expect(nudge).toContainEqual(
      expect.objectContaining({ kind: "warning", code: "chat-stopped" }),
    );

    const callsBefore = provider.calls;
    const resumed = await liveEdit(chatSessionId, { resume: { approvalId, approved: true } });
    expect(resumed.some((e) => e.kind === "error")).toBe(false);
    expect(provider.calls).toBe(callsBefore + 1);
    expect(await tokensNamed("t658-live-approve")).toBe(1);
    expect(await cards(chatSessionId)).toEqual([]);
  });

  it("Reject after Stop resumes the turn too (the AI reacts), and nothing is applied", async () => {
    const chatSessionId = await createChat("t658 live reject");
    provider.askToMint("t658-live-reject", "call-live-2");
    const approvalId = approvalIdOf(
      await liveEdit(chatSessionId, { content: "Mint a token.", operator: true }),
    );
    await stop(chatSessionId);
    const callsBefore = provider.calls;
    const resumed = await liveEdit(chatSessionId, { resume: { approvalId, approved: false } });
    expect(resumed.some((e) => e.kind === "error")).toBe(false);
    expect(provider.calls).toBe(callsBefore + 1);
    expect(await tokensNamed("t658-live-reject")).toBe(0);
  });

  it("a card a newer message moved past cannot resume anything", async () => {
    const chatSessionId = await createChat("t658 live superseded");
    provider.askToMint("t658-live-superseded", "call-live-3");
    const approvalId = approvalIdOf(
      await liveEdit(chatSessionId, { content: "Mint a token.", operator: true }),
    );
    await liveEdit(chatSessionId, { content: "Never mind, do something else.", operator: true });
    const late = await liveEdit(chatSessionId, { resume: { approvalId, approved: true } });
    expect(late).toContainEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("no longer open"),
      }),
    );
    expect(await tokensNamed("t658-live-superseded")).toBe(0);
  });
});

describe("case 2 — a Power-MCP proposal is handed back, never starting a chat turn", () => {
  it("approving after Stop applies, reaches the agent, adds no message and keeps the latch", async () => {
    const minted = await execute(registry, adapter, OWNER, "mcp_tokens.create", {
      displayName: "t658-power",
      scope: "admin",
    });
    if (!minted.ok) throw new Error(JSON.stringify(minted.error));
    const adminToken = (minted.value as { plaintextToken: string }).plaintextToken;
    const opened = await execute(registry, adapter, SYSTEM, "mcp.open_session", {
      plaintextToken: adminToken,
      newSession: true,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const { chatSessionId } = opened.value as { chatSessionId: string };
    const queued = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "propose_create_mcp_token",
      args: { displayName: "t658-power-minted" },
    });
    if (!queued.ok) throw new Error(JSON.stringify(queued.error));
    const { proposalId } = (queued.value as { approval: { proposalId: string } }).approval;

    await stop(chatSessionId);
    const before = await messageCount(chatSessionId);
    const applied = await execute(registry, adapter, OWNER, "mcp_tokens.execute_proposal", {
      proposalId,
    });
    expect(applied.ok).toBe(true);
    expect(await messageCount(chatSessionId)).toBe(before);
    expect(await chatStopped(chatSessionId)).toBe(true);
    const outcome = await execute(registry, adapter, SYSTEM, "mcp.get_approval_outcome", {
      plaintextToken: adminToken,
      proposalId,
    });
    expect(outcome.ok && (outcome.value as { outcome: string }).outcome).toBe("applied");
  });
});

describe("case 3 — a caelo_chat turn's approval goes back to the external agent", () => {
  async function chatToken(name: string, as: ExecutionContext = OWNER): Promise<string> {
    const r = await execute(registry, adapter, as, "mcp_tokens.create", {
      displayName: name,
      scope: "chat",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { plaintextToken: string }).plaintextToken;
  }

  async function sendChat(
    token: string,
    input: { message?: string; chatSessionId?: string; resume?: true },
  ) {
    return execute(registry, adapter, SYSTEM, "mcp.send_chat", {
      plaintextToken: token,
      ...(input.message ? { message: input.message } : {}),
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      ...(input.resume ? { resumeApprovals: true } : {}),
    });
  }

  async function state(token: string, chatSessionId: string) {
    const r = await execute(registry, adapter, SYSTEM, "mcp.get_chat_approval_state", {
      plaintextToken: token,
      chatSessionId,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { state: string }).state;
  }

  async function pausedChat(
    token: string,
    displayName: string,
    callId: string,
    as: ExecutionContext = OWNER,
  ) {
    const chatSessionId = await createChat(`t658 ${displayName}`, as);
    provider.askToMint(displayName, callId);
    const r = await sendChat(token, { message: "Mint a token for me.", chatSessionId });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = r.value as { pendingApprovals: { approvalId: string; toolName: string }[] };
    return { chatSessionId, pendingApprovals: v.pendingApprovals };
  }

  it("surfaces the card, records the operator's decision without a turn, and resumes the agent's own turn", async () => {
    const token = await chatToken("t658-chat-a");
    const { chatSessionId, pendingApprovals } = await pausedChat(
      token,
      "t658-chat-minted",
      "call-mcp-1",
    );
    expect(pendingApprovals).toEqual([
      expect.objectContaining({ toolName: "propose_create_mcp_token" }),
    ]);
    const approvalId = (pendingApprovals[0] as { approvalId: string }).approvalId;
    // The Live Edit chat lists it as the external agent's card.
    expect(await cards(chatSessionId)).toEqual([
      expect.objectContaining({ approvalId, source: "mcp_chat", status: "pending" }),
    ]);
    expect(await state(token, chatSessionId)).toBe("pending");
    // Nothing to resume before the decision; the Live Edit stream cannot take it over.
    const early = await sendChat(token, { chatSessionId, resume: true });
    expect(early.ok).toBe(false);
    const hijack = await liveEdit(chatSessionId, { resume: { approvalId, approved: true } });
    expect(hijack).toContainEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("external agent"),
      }),
    );

    // The operator's click: recorded, no message, no AI call.
    const before = await messageCount(chatSessionId);
    const callsBefore = provider.calls;
    const decided = await execute(registry, adapter, OWNER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    expect(decided.ok).toBe(true);
    expect(await messageCount(chatSessionId)).toBe(before);
    expect(provider.calls).toBe(callsBefore);
    expect(await tokensNamed("t658-chat-minted")).toBe(0);
    expect(await state(token, chatSessionId)).toBe("decided");

    // The agent's own call resumes ITS turn and gets the outcome.
    const resumed = await sendChat(token, { chatSessionId, resume: true });
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
    expect((resumed.value as { assistant: string }).assistant).toContain("Done.");
    expect(await tokensNamed("t658-chat-minted")).toBe(1);
    expect(await state(token, chatSessionId)).toBe("none");
    expect(await cards(chatSessionId)).toEqual([
      expect.objectContaining({ approvalId, status: "resumed", approved: true }),
    ]);
  });

  it("another user can neither list nor decide the chat's cards; the AI may not decide at all", async () => {
    const token = await chatToken("t658-chat-b");
    const { chatSessionId, pendingApprovals } = await pausedChat(
      token,
      "t658-chat-foreign",
      "call-mcp-2",
    );
    const approvalId = (pendingApprovals[0] as { approvalId: string }).approvalId;
    // codex review — the cards carry previews of what the chat's agents
    // asked for: only the chat's operator (or whoever manages every chat).
    const listed = await execute(registry, adapter, VIEWER, "chat.list_turn_approvals", {
      chatSessionId,
    });
    expect(listed.ok).toBe(false);
    const byViewer = await execute(registry, adapter, VIEWER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    expect(byViewer.ok).toBe(false);
    const byAi = await execute(registry, adapter, AI, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    expect(byAi.ok).toBe(false);
    expect(await state(token, chatSessionId)).toBe("pending");
  });

  it("approving needs the approver permission (#589), even in your own chat", async () => {
    const token = await chatToken("t658-chat-editor", VIEWER);
    const { chatSessionId, pendingApprovals } = await pausedChat(
      token,
      "t658-chat-perm",
      "call-mcp-7",
      VIEWER,
    );
    const approvalId = (pendingApprovals[0] as { approvalId: string }).approvalId;
    const byEditor = await execute(registry, adapter, VIEWER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    expect(byEditor.ok).toBe(false);
    expect(JSON.stringify(byEditor.ok ? null : byEditor.error)).toContain("settings.write");
    expect(await state(token, chatSessionId)).toBe("pending");
    // An Owner (manages every chat, holds the permission) may decide it.
    const byOwner = await execute(registry, adapter, OWNER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: false,
    });
    expect(byOwner.ok).toBe(true);
    expect(await state(token, chatSessionId)).toBe("decided");
  });

  it("a decision after Stop resumes the agent's turn but keeps the Live Edit AI stopped", async () => {
    const token = await chatToken("t658-chat-c");
    const { chatSessionId, pendingApprovals } = await pausedChat(
      token,
      "t658-chat-afterstop",
      "call-mcp-3",
    );
    const approvalId = (pendingApprovals[0] as { approvalId: string }).approvalId;
    await stop(chatSessionId);
    const decided = await execute(registry, adapter, OWNER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    expect(decided.ok).toBe(true);
    const resumed = await sendChat(token, { chatSessionId, resume: true });
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
    expect(await tokensNamed("t658-chat-afterstop")).toBe(1);
    // The latch holds for everything else.
    expect(await chatStopped(chatSessionId)).toBe(true);
    const nudge = await liveEdit(chatSessionId, { content: "Fix round 1.", operator: false });
    expect(nudge).toContainEqual(
      expect.objectContaining({ kind: "warning", code: "chat-stopped" }),
    );
  });

  it("a Stop after the decision refuses the resume", async () => {
    const token = await chatToken("t658-chat-d");
    const { chatSessionId, pendingApprovals } = await pausedChat(
      token,
      "t658-chat-stopafter",
      "call-mcp-4",
    );
    const approvalId = (pendingApprovals[0] as { approvalId: string }).approvalId;
    await execute(registry, adapter, OWNER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: true,
    });
    await Bun.sleep(5);
    await stop(chatSessionId);
    const resumed = await sendChat(token, { chatSessionId, resume: true });
    expect(resumed.ok).toBe(false);
    expect(JSON.stringify(resumed.ok ? null : resumed.error)).toContain("stopped_by_operator");
    expect(await tokensNamed("t658-chat-stopafter")).toBe(0);
  });

  it("a Rejected card resumes the agent's turn with the rejection; nothing is applied", async () => {
    const token = await chatToken("t658-chat-e");
    const { chatSessionId, pendingApprovals } = await pausedChat(
      token,
      "t658-chat-rejected",
      "call-mcp-5",
    );
    const approvalId = (pendingApprovals[0] as { approvalId: string }).approvalId;
    await execute(registry, adapter, OWNER, "chat.decide_turn_approval", {
      chatSessionId,
      approvalId,
      approved: false,
      reason: "not now",
    });
    const resumed = await sendChat(token, { chatSessionId, resume: true });
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
    expect(await tokensNamed("t658-chat-rejected")).toBe(0);
    expect(await cards(chatSessionId)).toEqual([
      expect.objectContaining({ approvalId, status: "resumed", approved: false }),
    ]);
  });

  it("an operator message in the chat supersedes the waiting card; the agent learns so", async () => {
    const token = await chatToken("t658-chat-f");
    const { chatSessionId } = await pausedChat(token, "t658-chat-moved-on", "call-mcp-6");
    await liveEdit(chatSessionId, { content: "Let's do the footer instead.", operator: true });
    expect(await state(token, chatSessionId)).toBe("superseded");
    const resumed = await sendChat(token, { chatSessionId, resume: true });
    expect(resumed.ok).toBe(false);
    expect(await tokensNamed("t658-chat-moved-on")).toBe(0);
  });
});
