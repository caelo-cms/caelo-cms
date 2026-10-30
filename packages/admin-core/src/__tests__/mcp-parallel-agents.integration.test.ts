// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1253 — 20 external agents of one client work in parallel.
 *
 * searchVIU production, 2026-10-29: five translation agents over one Claude
 * Code connection shared ONE chat, every write took that chat's turn lease
 * (the rest got `chat_busy`), and every request locked the connection row
 * three times. Here, against a real Postgres:
 *
 *  - 20 agents of one remote client open 20 chats on the shared draft,
 *    write in parallel without a single refusal, see each other's changes,
 *    and are stopped and undone each on their own;
 *  - writes to the same entity conflict against the version the call read —
 *    also two calls of ONE session — never overwriting silently;
 *  - a write call costs at most 3 transactions outside the tool's own ops,
 *    takes no row lock on the credential and writes `last_used_at` at most
 *    once a minute.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { defaultToolRegistry } from "../ai/tools/index.js";
import type { McpRemoteCredential } from "../ops/security/mcp_credential.js";
import { powerExecuteTool, powerOpenSession } from "../ops/security/mcp_power.js";
import { type McpPrincipal, resolveRemoteMcpPrincipal } from "../ops/security/mcp_principal.js";
import {
  configureMcpBridge,
  resolveMcpToken,
  type SendChatBridgeOpts,
} from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { createIapVerifier, setIapVerifierForTests } from "../security/iap-assertion.js";
import { iapTestKeyPair, signIapTestAssertion } from "../security/iap-assertion.test-helpers.js";
import { withToolCallVersion } from "../tool-call-version.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-admin";
const KEY = iapTestKeyPair("t1253-kid");
const OWNER = { id: "00000000-0000-4000-8125-300000000001", email: "owner@t1253.test" };
const AGENTS = 20;
const CLIENT = "dcr:Claude Code";
const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1253-system",
};
const ownerCtx: ExecutionContext = { actorId: OWNER.id, actorKind: "human", requestId: "t1253" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let bridge: SendChatBridgeOpts;
/** Statements of the adapter while `recording` is set (BEGIN / COMMIT included). */
let statements: string[] = [];
let recording = false;

function cred(): McpRemoteCredential {
  return {
    iapCredential: signIapTestAssertion(KEY, { aud: AUDIENCE, email: OWNER.email }),
    surface: "admin",
    client: CLIENT,
  };
}

/** What the remote route does once per request. */
async function principal(): Promise<McpPrincipal> {
  const r = await resolveRemoteMcpPrincipal(adapter, cred());
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

async function makeModule(slug: string): Promise<string> {
  const r = await execute(registry, adapter, systemCtx, "modules.create", {
    slug,
    displayName: slug,
    html: "<div>{{body}}</div>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!r.ok) throw new Error(`module ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { moduleId: string }).moduleId;
}

const rename = (moduleId: string, displayName: string) => ({
  items: [{ moduleId, displayName }],
});

async function call(
  p: McpPrincipal,
  chatSessionId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const r = await powerExecuteTool(bridge, p, { toolName, args, chatSessionId });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

async function displayNameOnDraft(moduleId: string, chatBranchId: string): Promise<string> {
  const r = await execute(registry, adapter, { ...ownerCtx, chatBranchId }, "modules.get", {
    moduleId,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { module: { displayName: string } }).module.displayName;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    onStatement: (s) => {
      if (recording) statements.push(s);
    },
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${OWNER.id}::uuid, 'human', ${OWNER.email}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${OWNER.id}::uuid, ${OWNER.email}, 'test-only') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${OWNER.id}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
  });
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => AUDIENCE,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
  bridge = { adapter, registry, resolveProvider: async () => null };
  configureMcpBridge(bridge);
});

afterAll(async () => {
  setIapVerifierForTests(null);
  await adapter.close();
});

describe("#1253 — 20 parallel agents of one client", () => {
  const sessions: { p: McpPrincipal; chatSessionId: string; chatBranchId: string }[] = [];
  const modules: string[] = [];

  it("open 20 chats on the shared draft and write in parallel without a refusal", async () => {
    const opened = await Promise.all(
      Array.from({ length: AGENTS }, async (_, i) => {
        const p = await principal();
        const r = await powerOpenSession(bridge, p, { title: `t1253 agent ${i}` });
        if (!r.ok) throw new Error(r.message);
        return { p, chatSessionId: r.value.chatSessionId, chatBranchId: r.value.chatBranchId };
      }),
    );
    sessions.push(...opened);
    expect(new Set(sessions.map((s) => s.chatSessionId)).size).toBe(AGENTS);
    // One shared draft, not 20 branches.
    expect(new Set(sessions.map((s) => s.chatBranchId)).size).toBe(1);

    for (let i = 0; i < AGENTS; i++) modules.push(await makeModule(`t1253-mod-${i}`));

    const started = performance.now();
    const results = await Promise.all(
      sessions.map(async (s, i) => {
        // Each agent is its own request: the route resolves the principal.
        const p = await principal();
        return call(
          p,
          s.chatSessionId,
          "update_modules_many",
          rename(modules[i] as string, `agent-${i}`),
        );
      }),
    );
    console.info(
      `[#1253] ${AGENTS} parallel agent writes: ${Math.round(performance.now() - started)} ms`,
    );
    for (const r of results) {
      expect(r.content).not.toContain("chat_busy");
      expect(r.ok).toBe(true);
    }

    // Each sees the others' changes: one shared draft.
    const branch = sessions[0]?.chatBranchId as string;
    for (let i = 0; i < AGENTS; i++) {
      expect(await displayNameOnDraft(modules[i] as string, branch)).toBe(`agent-${i}`);
    }

    // Each chat holds exactly its own agent's change (chat-keyed undo).
    const owners = await withSql(
      async (tx) =>
        (await tx`
          SELECT ms.module_id::text AS module_id, ss.chat_task_id::text AS chat
          FROM module_snapshots ms JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id IN ${tx(modules)} AND ss.chat_task_id IS NOT NULL
        `) as { module_id: string; chat: string }[],
    );
    for (let i = 0; i < AGENTS; i++) {
      expect(owners.filter((o) => o.module_id === modules[i]).map((o) => o.chat)).toEqual([
        sessions[i]?.chatSessionId as string,
      ]);
    }
  }, 120_000);

  it("Stop in one agent's chat stops that agent only", async () => {
    const [stoppedOne, other] = [sessions[3], sessions[4]];
    if (!stoppedOne || !other) throw new Error("sessions missing");
    const stop = await execute(registry, adapter, ownerCtx, "chat.cancel_agents", {
      chatSessionId: stoppedOne.chatSessionId,
    });
    expect(stop.ok).toBe(true);
    const refused = await call(await principal(), stoppedOne.chatSessionId, "list_modules", {});
    expect(refused.ok).toBe(false);
    expect(refused.content).toStartWith("stopped_by_operator");
    const runs = await call(await principal(), other.chatSessionId, "list_modules", {});
    expect(runs.ok).toBe(true);
  });

  it("undo in one agent's chat reverts that agent's change only", async () => {
    const [undone, kept] = [sessions[5], sessions[6]];
    if (!undone || !kept) throw new Error("sessions missing");
    const r = await call(await principal(), undone.chatSessionId, "undo_this_chat", {});
    expect(r.ok).toBe(true);
    const branch = undone.chatBranchId;
    expect(await displayNameOnDraft(modules[5] as string, branch)).toBe("t1253-mod-5");
    expect(await displayNameOnDraft(modules[6] as string, branch)).toBe("agent-6");
  });
});

describe("#1253 — concurrent writes of one entity conflict, never overwrite", () => {
  it("two calls of ONE session that both started before either wrote: the second is refused", async () => {
    const p = await principal();
    const opened = await powerOpenSession(bridge, p, { title: "t1253 one session" });
    if (!opened.ok) throw new Error(opened.message);
    const { chatSessionId, chatBranchId } = opened.value;
    const moduleId = await makeModule("t1253-shared");
    // Both calls read the same version: the snapshot before either wrote.
    const snapshot = await adapter.withAdminTransaction(systemCtx, async (tx) => {
      const rows = (await tx.execute(
        "SELECT pg_current_snapshot()::text AS s" as never,
      )) as unknown as { s: string }[];
      return rows[0]?.s as string;
    });
    const aiCtx: ExecutionContext = {
      actorId: OWNER.id,
      actorKind: "ai",
      requestId: "t1253-race",
      chatBranchId,
      chatTaskId: chatSessionId,
    };
    const write = (callId: string, displayName: string) =>
      withToolCallVersion({ callId, snapshot }, () =>
        execute(registry, adapter, aiCtx, "modules.update_many", {
          updates: [{ moduleId, displayName }],
        }),
      );
    const first = await write("call-1", "first");
    expect(first.ok).toBe(true);
    const second = await write("call-2", "second");
    const failed = second.ok ? (second.value as { failed: { message: string }[] }).failed : [];
    expect(second.ok ? failed.length : 1).toBe(1);
    expect(JSON.stringify(second)).toContain("another tool call");
    expect(await displayNameOnDraft(moduleId, chatBranchId)).toBe("first");
    // A call that starts after the first committed builds on it: no conflict.
    const later = await call(p, chatSessionId, "update_modules_many", rename(moduleId, "third"));
    expect(later.ok).toBe(true);
    expect(await displayNameOnDraft(moduleId, chatBranchId)).toBe("third");
  });

  it("two agents in two chats: the one that never read the other's change is refused", async () => {
    const a = await powerOpenSession(bridge, await principal(), { title: "t1253 A" });
    const b = await powerOpenSession(bridge, await principal(), { title: "t1253 B" });
    if (!a.ok || !b.ok) throw new Error("open");
    const moduleId = await makeModule("t1253-cross");
    const aWrite = await call(
      await principal(),
      a.value.chatSessionId,
      "update_modules_many",
      rename(moduleId, "from A"),
    );
    expect(aWrite.ok).toBe(true);
    const bWrite = await call(
      await principal(),
      b.value.chatSessionId,
      "update_modules_many",
      rename(moduleId, "from B"),
    );
    expect(bWrite.content).toContain("Conflict");
    expect(await displayNameOnDraft(moduleId, a.value.chatBranchId)).toBe("from A");
  });
});

describe("#1253 — a repeated call never runs twice", () => {
  it("a repeat that arrives while the first call runs is not started; a later one gets the cached result", async () => {
    const p = await principal();
    const opened = await powerOpenSession(bridge, p, { title: "t1253 idempotent" });
    if (!opened.ok) throw new Error(opened.message);
    const { chatSessionId } = opened.value;
    const moduleId = await makeModule("t1253-idem");
    const send = () =>
      powerExecuteTool(bridge, p, {
        toolName: "update_modules_many",
        args: rename(moduleId, "once"),
        chatSessionId,
        toolCallId: "t1253-same-call",
      });
    const [a, b] = await Promise.all([send(), send()]);
    const outcomes = [a, b].map((r) => (r.ok ? (r.value.cached ? "cached" : "ran") : r.message));
    // Exactly one ran; the other was told it runs (or, when it came after
    // the first finished, served its result).
    expect(outcomes.filter((o) => o === "ran")).toHaveLength(1);
    expect(
      outcomes
        .filter((o) => o !== "ran")
        .every((o) => o === "cached" || o.startsWith("in_progress")),
    ).toBe(true);
    const later = await send();
    expect(later.ok && later.value.cached).toBe(true);
    const writes = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM module_snapshots ms
                  JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
                  WHERE ms.module_id = ${moduleId}::uuid
                    AND ss.chat_task_id = ${chatSessionId}::uuid`) as { n: number }[],
    );
    expect(writes[0]?.n).toBe(1);
  });
});

describe("#1253 — the cost of one write call", () => {
  it("≤ 3 transactions outside the tool, no row lock on the credential, last_used_at at most once a minute", async () => {
    const p0 = await principal();
    const opened = await powerOpenSession(bridge, p0, { title: "t1253 cost" });
    if (!opened.ok) throw new Error(opened.message);
    const { chatSessionId, chatBranchId } = opened.value;
    const moduleId = await makeModule("t1253-cost");
    const begins = () => statements.filter((s) => s === "BEGIN").length;

    // One remote tools/call: the route resolves the principal, then the call.
    statements = [];
    recording = true;
    const p = await principal();
    const r = await powerExecuteTool(bridge, p, {
      toolName: "update_modules_many",
      args: rename(moduleId, "cost-1"),
      chatSessionId,
    });
    recording = false;
    expect(r.ok && r.value.ok).toBe(true);
    const wholeCall = begins();
    const lockingReads = statements.filter(
      (s) => /FOR\s+(UPDATE|SHARE)/i.test(s) && /mcp_remote_connections|mcp_tokens/i.test(s),
    );
    expect(lockingReads).toEqual([]);

    // The same tool alone, dispatched as the call would.
    const tools = defaultToolRegistry();
    statements = [];
    recording = true;
    const alone = await tools.dispatch(
      "update_modules_many",
      rename(moduleId, "cost-2"),
      {
        actorId: OWNER.id,
        actorKind: "ai",
        requestId: crypto.randomUUID(),
        chatBranchId,
        chatTaskId: chatSessionId,
      },
      {
        adapter,
        registry,
        chatSessionId,
        chatBranchId,
        toolCallId: `t1253-${crypto.randomUUID()}`,
        tools,
        humanCtx: { ...ownerCtx, chatBranchId },
        aiDelegated: true,
      },
    );
    recording = false;
    expect(alone.ok).toBe(true);
    const toolOnly = begins();
    console.info(
      `[#1253] write tools/call: ${wholeCall} transactions, ${toolOnly} of them the tool's own`,
    );
    expect(wholeCall - toolOnly).toBeLessThanOrEqual(3);

    // Three more requests within the minute: no further last_used_at write.
    statements = [];
    recording = true;
    for (let i = 0; i < 3; i++) await principal();
    recording = false;
    expect(statements.filter((s) => /UPDATE\s+mcp_remote_connections/i.test(s))).toEqual([]);
  });

  it("a token's last_used_at is written at most once a minute", async () => {
    const minted = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
      displayName: "t1253-token",
      scope: "admin",
    });
    if (!minted.ok) throw new Error(JSON.stringify(minted.error));
    const token = (minted.value as { plaintextToken: string }).plaintextToken;
    statements = [];
    recording = true;
    for (let i = 0; i < 4; i++) expect((await resolveMcpToken(adapter, token)).ok).toBe(true);
    recording = false;
    expect(statements.filter((s) => /UPDATE\s+mcp_tokens/i.test(s)).length).toBe(1);
    const used = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM mcp_tokens
                  WHERE display_name = 't1253-token' AND last_used_at IS NOT NULL`) as {
          n: number;
        }[],
    );
    expect(used[0]?.n).toBe(1);
    expect(statements.filter((s) => /FOR\s+UPDATE/i.test(s) && /mcp_tokens/i.test(s))).toEqual([]);
  });
});
