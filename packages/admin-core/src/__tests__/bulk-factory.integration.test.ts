// SPDX-License-Identifier: MPL-2.0

/**
 * Integration coverage for the DRY `defineBulkOp` factory (CLAUDE.md §11).
 *
 * Exercises the factory-built `_many` ops against a real Postgres:
 *  - `content_instances.set_values_many` updates N rows in one call and
 *    returns N results;
 *  - ATOMICITY — a batch with one invalid item (a non-existent id that makes
 *    the singular handler `err`) rolls back ALL items (no partial write
 *    persists);
 *  - `media.update_alt_many` (a second domain wired through the same factory)
 *    updates N assets in one call.
 *
 * Runs WITHOUT `CAELO_TEST_DB_RESET` — a plain run does not wipe the shared
 * dev DB; this test cleans up only the rows it seeds (by id) in afterAll.
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

const TS = Date.now();
const MODULE_SLUG = `bulk-fac-${TS}`;
const SHA_PREFIX = TS.toString(16).padStart(12, "0").slice(-12);
/** Two deterministic, unique 64-hex sha256 values for the seeded assets. */
const sha = (n: number) => `${SHA_PREFIX}${"0".repeat(64 - 13)}${n}`;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "bulk-factory-test",
};

// Ids captured at seed time so afterAll deletes exactly what this test made.
let moduleId: string;
const contentInstanceIds: string[] = [];
const assetIds: string[] = [];

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // content_instances → modules (FK order); media_variants → media_assets.
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = ${MODULE_SLUG})`;
      await tx`DELETE FROM modules WHERE slug = ${MODULE_SLUG}`;
      await tx`DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE sha256 IN (${sha(1)}, ${sha(2)}))`;
      await tx`DELETE FROM media_assets WHERE sha256 IN (${sha(1)}, ${sha(2)})`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  // Seed one module + two content_instances of it.
  const mod = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MODULE_SLUG,
    displayName: "Bulk Factory Test Module",
    html: "<p>bulk factory test module</p>",
  });
  if (!mod.ok) throw new Error(`module seed failed: ${JSON.stringify(mod.error)}`);
  moduleId = (mod.value as { moduleId: string }).moduleId;

  for (const title of ["orig-a", "orig-b"]) {
    const ci = await execute(registry, adapter, systemCtx, "content_instances.create", {
      moduleId,
      values: { title },
    });
    if (!ci.ok) throw new Error(`ci seed failed: ${JSON.stringify(ci.error)}`);
    contentInstanceIds.push((ci.value as { contentInstanceId: string }).contentInstanceId);
  }

  // Seed two media assets (system-scope upload op).
  for (const n of [1, 2]) {
    const up = await execute(registry, adapter, systemCtx, "media.upload", {
      sha256: sha(n),
      originalName: `bulk-fac-${n}.png`,
      mime: "image/png",
      sizeBytes: 1234,
      width: 100,
      height: 100,
      alt: `orig-alt-${n}`,
      storageKey: `bulk-fac/${TS}/${n}.png`,
      variants: [
        {
          variant: "original",
          format: "png",
          width: 100,
          height: 100,
          sizeBytes: 1234,
          storageKey: `bulk-fac/${TS}/${n}.png`,
        },
      ],
    });
    if (!up.ok) throw new Error(`media seed failed: ${JSON.stringify(up.error)}`);
    assetIds.push((up.value as { assetId: string }).assetId);
  }
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("content_instances.set_values_many (defineBulkOp)", () => {
  it("updates N instances in one call and returns N results", async () => {
    const r = await execute(registry, adapter, systemCtx, "content_instances.set_values_many", {
      items: [
        { id: contentInstanceIds[0], values: { title: "bulk-a" } },
        { id: contentInstanceIds[1], values: { title: "bulk-b" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { count: number; results: unknown[] };
    expect(v.count).toBe(2);
    expect(v.results.length).toBe(2);

    // Both live rows carry the new values.
    for (const [id, want] of [
      [contentInstanceIds[0], "bulk-a"],
      [contentInstanceIds[1], "bulk-b"],
    ] as const) {
      const got = await execute(registry, adapter, systemCtx, "content_instances.get", { id });
      if (!got.ok) throw new Error("get failed");
      const inst = (got.value as { instance: { values: Record<string, unknown> } }).instance;
      expect(inst.values.title).toBe(want);
    }
  });

  it("ATOMICITY: one invalid item rolls back the whole batch", async () => {
    // Snapshot the first instance's current state before the failing batch.
    const before = await execute(registry, adapter, systemCtx, "content_instances.get", {
      id: contentInstanceIds[0],
    });
    if (!before.ok) throw new Error("pre-read failed");
    const beforeInst = (
      before.value as { instance: { values: Record<string, unknown>; version: number } }
    ).instance;

    // Batch: a valid change to CI[0] + a change to a non-existent id (makes
    // the singular handler `err`, which must abort + roll back CI[0] too).
    const MISSING_ID = "00000000-0000-4000-8000-0000000000aa";
    const r = await execute(registry, adapter, systemCtx, "content_instances.set_values_many", {
      items: [
        { id: contentInstanceIds[0], values: { title: "SHOULD-NOT-PERSIST" } },
        { id: MISSING_ID, values: { title: "x" } },
      ],
    });
    expect(r.ok).toBe(false);

    // CI[0] must be byte-identical to its pre-batch state — nothing leaked.
    const after = await execute(registry, adapter, systemCtx, "content_instances.get", {
      id: contentInstanceIds[0],
    });
    if (!after.ok) throw new Error("post-read failed");
    const afterInst = (
      after.value as { instance: { values: Record<string, unknown>; version: number } }
    ).instance;
    expect(afterInst.values.title).toBe(beforeInst.values.title as string);
    expect(afterInst.values.title).not.toBe("SHOULD-NOT-PERSIST");
    expect(afterInst.version).toBe(beforeInst.version);
  });
});

describe("media.update_alt_many (defineBulkOp)", () => {
  it("updates N assets' alt text in one call", async () => {
    const r = await execute(registry, adapter, systemCtx, "media.update_alt_many", {
      items: [
        { assetId: assetIds[0], alt: "new-alt-1" },
        { assetId: assetIds[1], alt: "new-alt-2" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { count: number }).count).toBe(2);

    for (const [id, want] of [
      [assetIds[0], "new-alt-1"],
      [assetIds[1], "new-alt-2"],
    ] as const) {
      const got = await execute(registry, adapter, systemCtx, "media.get", { assetId: id });
      if (!got.ok) throw new Error("media.get failed");
      const asset = (got.value as { asset: { alt: string } | null }).asset;
      expect(asset?.alt).toBe(want);
    }
  });
});
