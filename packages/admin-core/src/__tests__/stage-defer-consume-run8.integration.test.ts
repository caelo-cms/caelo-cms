// SPDX-License-Identifier: MPL-2.0

/**
 * Run #8 R6 (issue #262) — a FAILED staging build must not consume the
 * chat branch.
 *
 * Pre-fix, /edit's ?/stageAndDeployStaging called chat.merge_to_main
 * (which stamped `last_staged_at` + released locks in its own tx) and
 * THEN deploy.trigger. When the build failed (run #8: generator error
 * `theme-font-unresolvable:36px, 13px, 20px, 42px`), the branch was
 * already spent: pending counter 0, Stage button gone, only "Publish
 * live" left — a dead end with no retry path.
 *
 * The fix splits consumption out of the merge: the Stage flow merges
 * with `deferConsume: true`, runs the build, and calls
 * `chat.finalize_stage` ONLY on build success. This test encodes the
 * op-level contract of that failure path:
 *
 *   1. merge(deferConsume) promotes entity state to the live tables
 *      (the build must see it) but leaves `last_staged_at` NULL, the
 *      pending count intact, and the entity locks held.
 *   2. Skipping finalize (= the build failed) leaves the branch fully
 *      retryable: a second merge(deferConsume) re-promotes the branch.
 *   3. finalize_stage (= the build succeeded) stamps `last_staged_at`
 *      to the MERGE timestamp and releases the locks — and edits made
 *      after the merge (i.e. while the build ran) stay pending because
 *      they were not part of the built output.
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
const PFX = "run8-defer-consume-";

const sysCtx: ExecutionContext = {
  actorId: HUMAN,
  actorKind: "system",
  requestId: "run8-defer",
};

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

/** last_staged_at for the session, read with the system actor set. */
async function readLastStagedAt(chatSessionId: string): Promise<string | null> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let value: string | null = null;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT last_staged_at::text AS last_staged_at
        FROM chat_sessions WHERE id = ${chatSessionId}::uuid
      `) as unknown as { last_staged_at: string | null }[];
      value = rows[0]?.last_staged_at ?? null;
    });
    return value;
  } finally {
    await sql.end();
  }
}

async function countLocks(chatSessionId: string): Promise<number> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let count = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT count(*)::int AS c FROM chat_entity_locks
        WHERE chat_session_id = ${chatSessionId}::uuid
      `) as unknown as { c: number }[];
      count = rows[0]?.c ?? 0;
    });
    return count;
  } finally {
    await sql.end();
  }
}

async function pendingCount(chatSessionId: string): Promise<number> {
  const r = await execute(registry, adapter, sysCtx, "chat.branch_change_count", {
    chatSessionId,
  });
  if (!r.ok) throw new Error(`branch_change_count: ${JSON.stringify(r.error)}`);
  return (r.value as { count: number }).count;
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

describe("run #8 R6 — deferred stage consumption", () => {
  it("failed-build path stays retryable; finalize_stage consumes only on success", async () => {
    const modRes = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}hero`,
      displayName: "Hero",
      html: "<p>v0</p>",
    });
    if (!modRes.ok) throw new Error("seed module");
    const moduleId = (modRes.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}chat`,
    });
    if (!session.ok) throw new Error("seed session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // Branched edit — acquires the entity lock and emits the branch snapshot.
    const branchCtx: ExecutionContext = { ...sysCtx, chatBranchId };
    const w1 = await execute(registry, adapter, branchCtx, "modules.update", {
      moduleId,
      html: "<p>v1</p>",
    });
    expect(w1.ok).toBe(true);
    expect(await pendingCount(chatSessionId)).toBe(1);

    // Step 1 of the Stage flow: merge WITHOUT consuming the branch.
    const merge1 = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId,
      deferConsume: true,
    });
    expect(merge1.ok).toBe(true);
    if (!merge1.ok) return;
    expect((merge1.value as { entityCount: number }).entityCount).toBe(1);

    // The live table HAS the merged state (the staging build reads it) ...
    const sqlLive = new SQL(ADMIN_URL as string);
    try {
      await sqlLive.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT html FROM modules WHERE id = ${moduleId}::uuid
        `) as unknown as { html: string }[];
        expect(rows[0]?.html).toBe("<p>v1</p>");
      });
    } finally {
      await sqlLive.end();
    }

    // ... but NOTHING was consumed: last_staged_at is still NULL, the
    // pending counter still shows the change (Stage stays offered in
    // the UI), and the entity lock is still held.
    expect(await readLastStagedAt(chatSessionId)).toBeNull();
    expect(await pendingCount(chatSessionId)).toBe(1);
    expect(await countLocks(chatSessionId)).toBeGreaterThan(0);

    // Failed-build path = finalize never called. The retry (operator
    // clicks Stage again) re-merges the freshest branch state.
    const merge2 = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId,
      deferConsume: true,
    });
    expect(merge2.ok).toBe(true);
    if (!merge2.ok) return;
    const merged2 = merge2.value as { entityCount: number; mergedAt: string };
    expect(merged2.entityCount).toBe(1);
    expect(await pendingCount(chatSessionId)).toBe(1);

    // An edit landing AFTER the merge (i.e. while the staging build is
    // running) must survive the eventual finalize as pending — it was
    // not part of the built output.
    const w2 = await execute(registry, adapter, branchCtx, "modules.update", {
      moduleId,
      html: "<p>v2-during-build</p>",
    });
    expect(w2.ok).toBe(true);

    // Success path: the build succeeded, so the Stage flow finalizes
    // with the merge timestamp.
    const finalize = await execute(registry, adapter, sysCtx, "chat.finalize_stage", {
      chatSessionId,
      stagedAt: merged2.mergedAt,
    });
    expect(finalize.ok).toBe(true);

    // Consumed: last_staged_at stamped, locks released ...
    expect(await readLastStagedAt(chatSessionId)).not.toBeNull();
    expect(await countLocks(chatSessionId)).toBe(0);

    // ... and exactly the DURING-BUILD edit is still pending (the
    // pre-merge edit is consumed; stamping now() instead of the merge
    // timestamp would have swallowed it).
    expect(await pendingCount(chatSessionId)).toBe(1);
  });
});

/**
 * Run #9 livedit regression (issue #262) — a re-Stage must replay ONLY
 * snapshots created since the last successful Stage.
 *
 * Pre-fix, chat.merge_to_main replayed the branch's LIFETIME snapshots
 * on every call: after "build homepage → Stage → re-edit the hero →
 * Stage", the second merge re-wrote every entity the chat had EVER
 * touched (bumping updated_at + version on all of them), so the
 * livedit suite's placement-isolation guard read "all placements
 * changed by the hero re-edit". The since-filter aligns the merge with
 * chat.list_pending_changes (v0.10.8): what the pending pill shows is
 * exactly what the next Stage ships.
 */
describe("run #9 — re-stage merges only since last_staged_at", () => {
  it("second stage replays the re-edited entity only, leaving the other untouched", async () => {
    const modA = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}since-a`,
      displayName: "Since A",
      html: "<p>a0</p>",
    });
    const modB = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}since-b`,
      displayName: "Since B",
      html: "<p>b0</p>",
    });
    if (!modA.ok || !modB.ok) throw new Error("seed modules");
    const moduleA = (modA.value as { moduleId: string }).moduleId;
    const moduleB = (modB.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}since-chat`,
    });
    if (!session.ok) throw new Error("seed session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const branchCtx: ExecutionContext = { ...sysCtx, chatBranchId };

    // Initial "homepage build": both entities edited on the branch.
    const e1 = await execute(registry, adapter, branchCtx, "modules.update", {
      moduleId: moduleA,
      html: "<p>a1</p>",
    });
    const e2 = await execute(registry, adapter, branchCtx, "modules.update", {
      moduleId: moduleB,
      html: "<p>b1</p>",
    });
    expect(e1.ok).toBe(true);
    expect(e2.ok).toBe(true);

    // Stage #1: merge everything + finalize (build succeeded).
    const merge1 = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId,
      deferConsume: true,
    });
    expect(merge1.ok).toBe(true);
    if (!merge1.ok) return;
    const merged1 = merge1.value as { entityCount: number; mergedAt: string };
    expect(merged1.entityCount).toBe(2);
    const finalize1 = await execute(registry, adapter, sysCtx, "chat.finalize_stage", {
      chatSessionId,
      stagedAt: merged1.mergedAt,
    });
    expect(finalize1.ok).toBe(true);

    // Snapshot B's live row state after Stage #1.
    const readModule = async (id: string): Promise<{ html: string; updated_at: string }> => {
      const sqlRead = new SQL(ADMIN_URL as string);
      try {
        let row: { html: string; updated_at: string } | undefined;
        await sqlRead.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const rows = (await tx`
            SELECT html, updated_at::text AS updated_at
            FROM modules WHERE id = ${id}::uuid
          `) as unknown as { html: string; updated_at: string }[];
          row = rows[0];
        });
        if (!row) throw new Error(`module ${id} not found`);
        return row;
      } finally {
        await sqlRead.end();
      }
    };
    const bAfterStage1 = await readModule(moduleB);
    expect(bAfterStage1.html).toBe("<p>b1</p>");

    // The "hero re-edit": only A changes after Stage #1.
    const e3 = await execute(registry, adapter, branchCtx, "modules.update", {
      moduleId: moduleA,
      html: "<p>a2</p>",
    });
    expect(e3.ok).toBe(true);

    // Stage #2 must merge ONLY A — pre-fix this replayed both entities
    // (entityCount 2) and bumped B's updated_at/version for no edit.
    const merge2 = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId,
      deferConsume: true,
    });
    expect(merge2.ok).toBe(true);
    if (!merge2.ok) return;
    expect((merge2.value as { entityCount: number }).entityCount).toBe(1);

    const aAfterStage2 = await readModule(moduleA);
    const bAfterStage2 = await readModule(moduleB);
    expect(aAfterStage2.html).toBe("<p>a2</p>");
    expect(bAfterStage2.html).toBe("<p>b1</p>");
    expect(bAfterStage2.updated_at).toBe(bAfterStage1.updated_at);
  });
});
