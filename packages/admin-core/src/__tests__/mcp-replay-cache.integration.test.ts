// SPDX-License-Identifier: MPL-2.0

/**
 * #1704 — a Power-MCP replay is only ever the same call.
 *
 * The idempotency cache (`chat_tool_results`, keyed by chat session + tool
 * call id) served whatever row it found under a key, whatever tool and
 * arguments the new call carried: an agent whose client sent a JSON-RPC id
 * again got the result of an EARLIER, DIFFERENT call, marked `cached`, and
 * the call it asked for never ran. Driven here through `mcp.execute_tool` —
 * the op `/api/mcp/tool` runs, where the caller names the key itself —
 * against a real Postgres:
 *
 *  - a key that names a different call (another tool, or other arguments)
 *    is refused with the next step, and nothing runs;
 *  - a resend of the same write call is still served once, never run twice;
 *  - a read is never replayed;
 *  - a key binds its call for IDEMPOTENCY_WINDOW_MS only: after it, the next
 *    call under the key runs and takes the key over;
 *  - a row without a digest (written by the previous release) is never
 *    served to a call;
 *  - a key taken over by a later call never replays the earlier call's
 *    approval hand-off.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { IDEMPOTENCY_WINDOW_MS } from "../ops/security/mcp_tool_call.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER = { id: "00000000-0000-4000-8170-400000000001", email: "owner@t1704.test" };
const ownerCtx: ExecutionContext = { actorId: OWNER.id, actorKind: "human", requestId: "t1704" };
const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1704-system",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let token: string;
let chatSessionId: string;
let chatBranchId: string;

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
  const r = await execute(registry, adapter, system, "modules.create", {
    slug,
    displayName: slug,
    html: "<div>{{body}}</div>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!r.ok) throw new Error(`module ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { moduleId: string }).moduleId;
}

async function displayName(moduleId: string): Promise<string> {
  const r = await execute(registry, adapter, { ...ownerCtx, chatBranchId }, "modules.get", {
    moduleId,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { module: { displayName: string } }).module.displayName;
}

const rename = (moduleId: string, to: string) => ({ items: [{ moduleId, displayName: to }] });

interface ToolAnswer {
  ok: boolean;
  content: string;
  cached: boolean;
  approval?: { proposalId: string; domain: string } | null;
}

/** What `/api/mcp/tool` answers: the result, or the refusal's message. */
async function send(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
): Promise<ToolAnswer | { refused: string }> {
  const r = await execute(registry, adapter, system, "mcp.execute_tool", {
    plaintextToken: token,
    chatSessionId,
    toolName,
    args,
    toolCallId,
  });
  if (!r.ok) return { refused: "message" in r.error ? String(r.error.message) : r.error.kind };
  return r.value as ToolAnswer;
}

/** A call that must be answered (not refused). */
async function call(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
): Promise<ToolAnswer> {
  const r = await send(toolName, args, toolCallId);
  if ("refused" in r) throw new Error(`${toolName} refused: ${r.refused}`);
  return r;
}

/** A call that must be refused: its message. */
async function refusal(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
): Promise<string> {
  const r = await send(toolName, args, toolCallId);
  if (!("refused" in r)) throw new Error(`${toolName} answered: ${r.content}`);
  return r.refused;
}

/** Make the key's row look `ms` older than it is. */
async function age(toolCallId: string, ms: number): Promise<void> {
  await withSql(
    (tx) => tx`UPDATE chat_tool_results
               SET created_at = created_at - ${ms}::int * interval '1 millisecond'
               WHERE chat_session_id = ${chatSessionId}::uuid AND tool_call_id = ${toolCallId}`,
  );
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
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
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
  const minted = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
    displayName: "t1704-token",
    scope: "power",
  });
  if (!minted.ok) throw new Error(`token: ${JSON.stringify(minted.error)}`);
  token = (minted.value as { plaintextToken: string }).plaintextToken;
  const opened = await execute(registry, adapter, system, "mcp.open_session", {
    plaintextToken: token,
    title: "t1704 replay cache",
  });
  if (!opened.ok) throw new Error(`open_session: ${JSON.stringify(opened.error)}`);
  ({ chatSessionId, chatBranchId } = opened.value as {
    chatSessionId: string;
    chatBranchId: string;
  });
});

afterAll(async () => {
  await adapter.close();
});

describe("#1704 — a key replays only its own call", () => {
  it("another call under a used key is refused with the next step, and does not run", async () => {
    const moduleA = await makeModule("t1704-a");
    const moduleB = await makeModule("t1704-b");
    expect((await call("update_modules_many", rename(moduleA, "first"), "t1704-key-1")).ok).toBe(
      true,
    );

    // Other arguments, same tool: before #1704 this answered with the first
    // call's cached result, and moduleB was never renamed.
    const otherArgs = await refusal(
      "update_modules_many",
      rename(moduleB, "second"),
      "t1704-key-1",
    );
    expect(otherArgs).toContain("tool_call_id_reused");
    expect(otherArgs).toContain("update_modules_many");
    expect(await displayName(moduleB)).toBe("t1704-b");

    // Another tool: the first call's result is not served either.
    const otherTool = await refusal("delete_modules_many", { moduleIds: [moduleB] }, "t1704-key-1");
    expect(otherTool).toContain("tool_call_id_reused");
    expect(await displayName(moduleB)).toBe("t1704-b");
  });

  it("a resend of the same write call is served its first result and does not run again", async () => {
    const moduleId = await makeModule("t1704-resend");
    const first = await call("update_modules_many", rename(moduleId, "once"), "t1704-key-2");
    expect(first.cached).toBe(false);
    // A rename in between: running the resend again would undo it.
    await call("update_modules_many", rename(moduleId, "later"), "t1704-key-2b");
    // The arguments in another key order are still the same call.
    const resend = await call(
      "update_modules_many",
      { items: [{ displayName: "once", moduleId }] },
      "t1704-key-2",
    );
    expect(resend.cached).toBe(true);
    expect(resend.content).toBe(first.content);
    expect(await displayName(moduleId)).toBe("later");
  });

  it("a read is never replayed: each one answers with the current state", async () => {
    const moduleId = await makeModule("t1704-read");
    const before = await call("list_modules", { filter: "t1704-read" }, "t1704-key-3");
    expect(before.cached).toBe(false);
    await call("update_modules_many", rename(moduleId, "renamed since"), "t1704-key-3b");
    const again = await call("list_modules", { filter: "t1704-read" }, "t1704-key-3");
    expect(again.cached).toBe(false);
    expect(again.content).toContain("renamed since");
  });

  it("after the window the key is free: the next call under it runs", async () => {
    const moduleId = await makeModule("t1704-window");
    await call("update_modules_many", rename(moduleId, "first"), "t1704-key-4");
    await call("update_modules_many", rename(moduleId, "between"), "t1704-key-4b");
    await age("t1704-key-4", IDEMPOTENCY_WINDOW_MS + 60_000);

    // The same call again, long after any resend: it runs.
    const same = await call("update_modules_many", rename(moduleId, "first"), "t1704-key-4");
    expect(same.cached).toBe(false);
    expect(await displayName(moduleId)).toBe("first");

    // A different call once the window passed: it runs and owns the key.
    await age("t1704-key-4", IDEMPOTENCY_WINDOW_MS + 60_000);
    const other = await call("update_modules_many", rename(moduleId, "third"), "t1704-key-4");
    expect(other.cached).toBe(false);
    expect(await displayName(moduleId)).toBe("third");
    const resend = await call("update_modules_many", rename(moduleId, "third"), "t1704-key-4");
    expect(resend.cached).toBe(true);
  });

  it("a row without a digest (the previous release) is never served", async () => {
    const moduleId = await makeModule("t1704-legacy");
    await withSql(
      (tx) => tx`INSERT INTO chat_tool_results
                   (chat_session_id, tool_call_id, tool_name, result_ok, result_content)
                 VALUES (${chatSessionId}::uuid, 't1704-key-5', 'load_skill', true,
                         'a skill body from an earlier call')`,
    );
    const r = await refusal("update_modules_many", rename(moduleId, "renamed"), "t1704-key-5");
    expect(r).toContain("tool_call_id_reused");
    expect(await displayName(moduleId)).toBe("t1704-legacy");
  });

  it("a key taken over after the window never replays the earlier call's approval hand-off", async () => {
    const proposed = await call(
      "propose_create_mcp_token",
      { displayName: "t1704-handoff" },
      "t1704-key-6",
    );
    expect(proposed.approval?.proposalId).toBeTruthy();
    await age("t1704-key-6", IDEMPOTENCY_WINDOW_MS + 60_000);

    const moduleId = await makeModule("t1704-handoff");
    const later = await call("update_modules_many", rename(moduleId, "later"), "t1704-key-6");
    expect(later.cached).toBe(false);
    expect(later.approval ?? null).toBeNull();
    // Its resend is its own replay: no wait on the earlier call's proposal.
    const resend = await call("update_modules_many", rename(moduleId, "later"), "t1704-key-6");
    expect(resend.cached).toBe(true);
    expect(resend.approval ?? null).toBeNull();
  });
});
