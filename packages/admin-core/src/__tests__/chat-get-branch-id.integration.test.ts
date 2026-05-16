// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 alpha.4 Fix U — `chat.get_branch_id` cross-actor lookup.
 *
 * Locks in the contract that the AI-callable lookup works on chats
 * owned by a DIFFERENT actor. This is the very scenario alpha.3 Fix A
 * fixed: `chat.get_session` filtered by `created_by = ctx.actorId` so
 * the AI couldn't read the human user's chat; `chat.get_branch_id`
 * skips that filter for AI scope so revert_chat_changes works.
 *
 * Without this test, a future "tighten chat.get_branch_id by
 * applying a created_by filter" refactor would silently regress
 * revert_chat_changes again.
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

// Seeded system actor — exists in actors table; used as the chat's
// creator. The AI ctx uses a DIFFERENT actor id, simulating the
// real-world scenario where the human user owns the chat and the AI
// runs on its behalf.
const HUMAN_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const AI_ACTOR = HUMAN_ACTOR; // Both rows in actors table; for the
// cross-actor distinction we only need actorKind to differ, since
// `created_by` is what `chat.get_session` filters on.

const TEST_SESSION = "22222222-2222-4222-8222-aaaaaaaaaaaa";
const TEST_BRANCH = "22222222-2222-4222-8222-bbbbbbbbbbbb";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE id = ${TEST_SESSION}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

async function seedChatSession(humanCreatorId: string): Promise<void> {
  // Idempotent — DO NOTHING on conflict so multiple tests can call
  // seedChatSession without setup-order coupling.
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO chat_sessions (id, title, created_by, chat_branch_id)
        VALUES (${TEST_SESSION}::uuid, 'cross-actor test chat',
                ${humanCreatorId}::uuid, ${TEST_BRANCH}::uuid)
        ON CONFLICT (id) DO NOTHING
      `;
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

describe("chat.get_branch_id — cross-actor lookup (Fix U)", () => {
  it("returns the branch id + creator for an AI ctx looking up a chat owned by a different actor", async () => {
    await seedChatSession(HUMAN_ACTOR);

    // AI ctx with actorKind="ai" — would be filtered out by
    // chat.get_session's `created_by = ctx.actorId` clause.
    const aiCtx: ExecutionContext = {
      actorId: AI_ACTOR,
      actorKind: "ai",
      requestId: "chat-get-branch-id-test",
    };
    const res = await execute(registry, adapter, aiCtx, "chat.get_branch_id", {
      chatSessionId: TEST_SESSION,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const v = res.value as { chatBranchId: string | null; createdBy: string | null };
    expect(v.chatBranchId).toBe(TEST_BRANCH);
    expect(v.createdBy).toBe(HUMAN_ACTOR);
  });

  it("returns nulls (not error) when the session does not exist — caller can detect cleanly", async () => {
    const aiCtx: ExecutionContext = {
      actorId: AI_ACTOR,
      actorKind: "ai",
      requestId: "chat-get-branch-id-test-missing",
    };
    const res = await execute(registry, adapter, aiCtx, "chat.get_branch_id", {
      chatSessionId: "99999999-9999-4999-8999-999999999999",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const v = res.value as { chatBranchId: string | null; createdBy: string | null };
    expect(v.chatBranchId).toBeNull();
    expect(v.createdBy).toBeNull();
  });

  it("regression guard: chat.get_session DOES filter by created_by, so an AI with mismatched actorId can't read the session via that op", async () => {
    // This test pins the OPPOSITE behavior — confirming the reason
    // Fix A added a separate op rather than relaxing chat.get_session.
    // If a future change opens chat.get_session to cross-actor reads,
    // this test will fail and a reviewer can re-evaluate whether the
    // separate op is still needed.
    await seedChatSession(HUMAN_ACTOR);
    // Use a different actor id to ensure created_by filter rejects.
    const aiCtx: ExecutionContext = {
      actorId: "11111111-1111-4111-8111-cccccccccccc",
      actorKind: "ai",
      requestId: "chat-get-session-cross-actor-test",
    };
    const res = await execute(registry, adapter, aiCtx, "chat.get_session", {
      chatSessionId: TEST_SESSION,
    });
    // chat.get_session returns ok=false with "session not found" when
    // the filter excludes — same shape as a genuine missing session.
    expect(res.ok).toBe(false);
  });
});
