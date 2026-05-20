// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.19 — `chat.merge_to_main` (Stage) releases per-entity locks.
 *
 * Pre-v0.10.19 only `chat.publish` and `chat.archive_session` released
 * the locks acquired by `checkAndAcquireEntityLock`. `chat.merge_to_main`
 * (the Stage button) merged branched snapshots into main + stamped
 * `last_staged_at` but left lock rows behind. Symptom:
 *   1. Chat A writes to page X → acquires lock.
 *   2. Chat A's operator clicks Stage → merge_to_main runs.
 *   3. UI shows "live matches staging" (pending = 0) and hides the
 *      Stage button — there's nothing left to publish.
 *   4. Chat B tries to edit page X → `page X is busy in another chat
 *      ('Live edit') — finish that chat (Stage + Publish)` — but
 *      there's nothing left in chat A to Stage. Operator stuck.
 *
 * Once Stage merged the branch into main, the lock's purpose (prevent
 * divergent unmerged edits) no longer applies. v0.10.19 releases at
 * merge_to_main; re-acquisition is automatic if chat A keeps editing
 * the same entity (atomic upsert).
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

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "v01019-stage-unlock-";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
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

describe("v0.10.19 — chat.merge_to_main releases entity locks", () => {
  it("after Stage, a second chat can write to the previously locked entity", async () => {
    const sysCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "v01019-test",
    };

    // Seed a module that both chats will try to edit.
    const modRes = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}hero`,
      displayName: "Hero",
      html: "<p>v0</p>",
    });
    if (!modRes.ok) throw new Error("seed module");
    const moduleId = (modRes.value as { moduleId: string }).moduleId;

    // Chat A — the chat that holds (and then should release) the lock.
    const cA = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}Chat A`,
    });
    if (!cA.ok) throw new Error("seed chat A");
    const { chatSessionId: idA, chatBranchId: branchA } = cA.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // Chat B — the contender that gets stuck pre-v0.10.19.
    const cB = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}Chat B`,
    });
    if (!cB.ok) throw new Error("seed chat B");
    const { chatBranchId: branchB } = cB.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // Chat A acquires the lock by editing the module.
    const editAsA: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "v01019-write-a",
      chatBranchId: branchA,
    };
    const w1 = await execute(registry, adapter, editAsA, "modules.update", {
      moduleId,
      html: "<p>v1</p>",
    });
    expect(w1.ok).toBe(true);

    // Pre-v0.10.19 baseline: while chat A holds the lock, chat B is
    // rejected. Asserting this so the test is meaningful — if some
    // future refactor removes the lock entirely, this guard fails
    // loudly instead of giving a false-positive pass on the release.
    const editAsB: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "v01019-write-b-pre",
      chatBranchId: branchB,
    };
    const wBBlocked = await execute(registry, adapter, editAsB, "modules.update", {
      moduleId,
      html: "<p>v-from-b</p>",
    });
    expect(wBBlocked.ok).toBe(false);
    if (wBBlocked.ok) return;
    expect((wBBlocked.error as { kind: string }).kind).toBe("Locked");

    // Chat A Stages — pre-v0.10.19 left the lock behind; v0.10.19
    // releases it.
    const stage = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId: idA,
    });
    if (!stage.ok) throw new Error(`merge_to_main: ${JSON.stringify(stage.error)}`);

    // Chat B can now write — the entity is no longer locked.
    const wBNow = await execute(registry, adapter, editAsB, "modules.update", {
      moduleId,
      html: "<p>v-from-b</p>",
    });
    expect(wBNow.ok).toBe(true);

    // Belt-and-braces: the lock row is gone.
    const sql = new SQL(ADMIN_URL as string);
    try {
      const rows = (await sql`
        SELECT entity_id::text AS entity_id
        FROM chat_entity_locks
        WHERE chat_session_id = ${idA}::uuid
      `) as unknown as { entity_id: string }[];
      expect(rows.length).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
