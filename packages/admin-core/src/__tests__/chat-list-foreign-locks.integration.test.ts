// SPDX-License-Identifier: MPL-2.0

/**
 * issue #262 — `chat.list_foreign_locks` integration coverage.
 *
 * Run #7: the migration chat only discovered a stale "Live edit" chat's
 * locks (theme, chrome modules, homepage) when writes bounced mid-run.
 * The op under test powers the `# Locks held by other chats` system-
 * prompt block so the AI can warn during planning instead.
 *
 * Asserts:
 *   1. Chat B sees chat A's lock, with entity label, holder title, and
 *      the holder's pending-change count.
 *   2. Chat A does NOT see its own lock (self-exclusion).
 *   3. After chat A Stages (merge_to_main releases locks, v0.10.19),
 *      chat B sees nothing.
 *   4. An unknown session id fails loudly (no silent "all locks are
 *      foreign" fallback — CLAUDE.md §2).
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
const PFX = "i262-foreign-locks-";

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

interface ForeignLocksValue {
  locks: Array<{
    entityKind: string;
    entityId: string;
    label: string;
    lockedAt: string;
    holder: {
      chatSessionId: string;
      title: string;
      pageSlug: string | null;
      pendingChangeCount: number;
    };
  }>;
}

describe("chat.list_foreign_locks (issue #262)", () => {
  it("surfaces other chats' locks with labels + holder context, excludes own, empties after Stage", async () => {
    const sysCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "i262-test",
    };

    const modRes = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}hero`,
      displayName: "Foreign Lock Hero",
      html: "<p>v0</p>",
    });
    if (!modRes.ok) throw new Error("seed module");
    const moduleId = (modRes.value as { moduleId: string }).moduleId;

    const cA = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}Chat A`,
    });
    if (!cA.ok) throw new Error("seed chat A");
    const { chatSessionId: idA, chatBranchId: branchA } = cA.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const cB = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}Chat B`,
    });
    if (!cB.ok) throw new Error("seed chat B");
    const { chatSessionId: idB } = cB.value as { chatSessionId: string };

    // Chat A edits the module → acquires the lock + writes one branch snapshot.
    const editAsA: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "i262-write-a",
      chatBranchId: branchA,
    };
    const w1 = await execute(registry, adapter, editAsA, "modules.update", {
      moduleId,
      html: "<p>v1</p>",
    });
    expect(w1.ok).toBe(true);

    // 1. Chat B sees chat A's lock, enriched.
    const seenByB = await execute(registry, adapter, sysCtx, "chat.list_foreign_locks", {
      chatSessionId: idB,
    });
    expect(seenByB.ok).toBe(true);
    if (!seenByB.ok) return;
    const foreign = (seenByB.value as ForeignLocksValue).locks.filter(
      (l) => l.entityId === moduleId,
    );
    expect(foreign.length).toBe(1);
    const row = foreign[0];
    if (!row) return;
    expect(row.entityKind).toBe("module");
    expect(row.label).toBe("Foreign Lock Hero");
    expect(row.holder.chatSessionId).toBe(idA);
    expect(row.holder.title).toBe(`${PFX}Chat A`);
    expect(row.holder.pendingChangeCount).toBeGreaterThanOrEqual(1);

    // 2. Chat A doesn't see its own lock.
    const seenByA = await execute(registry, adapter, sysCtx, "chat.list_foreign_locks", {
      chatSessionId: idA,
    });
    expect(seenByA.ok).toBe(true);
    if (!seenByA.ok) return;
    expect(
      (seenByA.value as ForeignLocksValue).locks.filter((l) => l.entityId === moduleId).length,
    ).toBe(0);

    // 3. Chat A Stages → locks released → nothing foreign for chat B.
    const stage = await execute(registry, adapter, sysCtx, "chat.merge_to_main", {
      chatSessionId: idA,
    });
    if (!stage.ok) throw new Error(`merge_to_main: ${JSON.stringify(stage.error)}`);
    const afterStage = await execute(registry, adapter, sysCtx, "chat.list_foreign_locks", {
      chatSessionId: idB,
    });
    expect(afterStage.ok).toBe(true);
    if (!afterStage.ok) return;
    expect(
      (afterStage.value as ForeignLocksValue).locks.filter((l) => l.entityId === moduleId).length,
    ).toBe(0);
  });

  it("rejects an unknown session id loudly", async () => {
    const sysCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "i262-unknown",
    };
    const r = await execute(registry, adapter, sysCtx, "chat.list_foreign_locks", {
      chatSessionId: "99999999-9999-4999-8999-999999999999",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { message?: string }).message).toBe("session not found");
  });
});
