// SPDX-License-Identifier: MPL-2.0

/**
 * Archival hook (P12A wires the cron; P4 ships the schema + op):
 *   - snapshots.archive_older_than sets archived_at on rows older than the
 *     cutoff and returns the count.
 *   - snapshots.list ignores archived rows by default; includeArchived=true
 *     reveals them.
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

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "snapshots-archive-test",
};

const MOD_SLUG = "p4-archive-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
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

describe("snapshots.archive_older_than", () => {
  it("archives matching rows; list hides them by default; includeArchived reveals them", async () => {
    const c = await execute(registry, adapter, ctx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "X",
      html: "<p>v1</p>",
    });
    if (!c.ok) throw new Error("create");
    const moduleId = (c.value as { moduleId: string }).moduleId;

    // Backdate the create snapshot so it's older than `before`.
    const sqlIface = new SQL(ADMIN_URL!);
    try {
      await sqlIface.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`
          UPDATE site_snapshots SET created_at = now() - interval '90 days'
          WHERE id IN (
            SELECT site_snapshot_id FROM module_snapshots WHERE module_id = ${moduleId}::uuid
          )
        `;
      });
    } finally {
      await sqlIface.end();
    }

    // Snapshot is visible before archival.
    const before = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forModuleId: moduleId,
    });
    if (!before.ok) return;
    expect((before.value as { snapshots: unknown[] }).snapshots.length).toBe(1);

    // Archive everything older than 30 days.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await execute(registry, adapter, ctx, "snapshots.archive_older_than", {
      before: cutoff,
      limit: 1000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { archivedCount: number }).archivedCount).toBeGreaterThanOrEqual(1);

    // Hot list now hides it.
    const hot = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forModuleId: moduleId,
    });
    if (!hot.ok) return;
    expect((hot.value as { snapshots: unknown[] }).snapshots.length).toBe(0);

    // Cold list reveals it.
    const cold = await execute(registry, adapter, ctx, "snapshots.list", {
      limit: 100,
      forModuleId: moduleId,
      includeArchived: true,
    });
    if (!cold.ok) return;
    expect((cold.value as { snapshots: unknown[] }).snapshots.length).toBe(1);
  });

  it("rejects an `ai` actor (system-only)", async () => {
    const aiCtx: ExecutionContext = {
      actorId: "11111111-1111-4111-8111-111111111111",
      actorKind: "ai",
      requestId: "ai",
    };
    const r = await execute(registry, adapter, aiCtx, "snapshots.archive_older_than", {
      before: new Date().toISOString(),
      limit: 10,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { kind: string }).kind).toBe("ActorScopeRejected");
  });
});
