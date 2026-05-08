// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.61 — Regression test for the chat-branch session lookup that
 * propose_* ops do via `_propose-helpers.resolveChatSessionId()`.
 *
 * Pre-v0.2.61 the helper queried a `chat_branches` table that does
 * not exist in any migration — every propose_* op called from inside
 * a chat (where ctx.chatBranchId is set by the runner) threw:
 *
 *   templates.propose_update failed: Failed query:
 *   SELECT chat_session_id::text AS chat_session_id
 *   FROM chat_branches WHERE id = $1::uuid LIMIT 1
 *
 * The fix queries `chat_sessions WHERE chat_branch_id = $1` —
 * `chat_branch_id` is a NOT NULL UNIQUE column on chat_sessions, so
 * there's exactly one session per branch.
 *
 * The existing propose-execute tests passed because they ran with an
 * AI ExecutionContext that did NOT carry a chatBranchId; the helper
 * returned null early without hitting the broken query. This test
 * exercises the chat-branch path explicitly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v0261-pfc",
};
const AI_BASE: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "v0261-pfc-ai",
};

const TEST_TAG = "v0261-pfc";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM user_pending_actions WHERE proposed_by IN (${AI_BASE.actorId}::uuid, ${HUMAN.actorId}::uuid)`;
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${TEST_TAG}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${TEST_TAG}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${TEST_TAG}%`}`;
      await tx`DELETE FROM users WHERE email LIKE ${`${TEST_TAG}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("propose_* from a chat-branch context (v0.2.61)", () => {
  it("resolves chat_session_id via chat_sessions.chat_branch_id and stamps it on the pending row", async () => {
    // 1. Create a chat session — this allocates a chat_branch_id.
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${TEST_TAG}-session-1`,
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    expect(chatSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chatBranchId).toMatch(/^[0-9a-f-]{36}$/);

    // 2. Build an AI context with that chat_branch_id — this is what
    //    chat-runner.ts builds via aiCtxWithBranch on every loop.
    const aiCtx: ExecutionContext = { ...AI_BASE, chatBranchId };

    // 3. Fire a propose_* op. Pre-v0.2.61 this threw "Failed query"
    //    because the helper looked at a non-existent table. Post-fix
    //    it resolves the session id from chat_sessions and stamps
    //    it on the pending row.
    const proposeResult = await execute(registry, adapter, aiCtx, "users.propose_create", {
      email: `${TEST_TAG}-propose@example.com`,
      displayName: "Propose-from-chat test user",
      roleNames: [],
    });
    expect(proposeResult.ok).toBe(true);
    const proposalId = (proposeResult as { ok: true; value: { proposalId: string } }).value
      .proposalId;

    // 4. The pending row should carry the chat_session_id we got from
    //    the session, NOT null.
    const sql = new SQL(ADMIN_URL!);
    let row: { chat_session_id: string | null } | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT chat_session_id::text AS chat_session_id
          FROM user_pending_actions
          WHERE id = ${proposalId}::uuid
        `) as unknown as { chat_session_id: string | null }[];
        row = rows[0];
      });
    } finally {
      await sql.end();
    }
    expect(row).toBeDefined();
    expect(row?.chat_session_id).toBe(chatSessionId);
  });
});
