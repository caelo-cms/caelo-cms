// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — media library integration tests.
 *
 *  - media.upload inserts an asset + variants and returns a stable id
 *  - re-uploading the same content (sha) is deduped
 *  - media.list / media.get round-trip the row + variants
 *  - media.update_alt updates the alt field
 *  - media.delete soft-deletes; force=true required when usage_count > 0
 *  - the usage tracker bumps usage_count on modules.update + decrements
 *    when a media reference is removed
 *  - media.recent_for_ai returns recent + most-used assets
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-integration-test",
};

// All sha values used by this test — tagged with a stable prefix so wipe()
// can scrub even if a prior run failed mid-test.
const TEST_PREFIX = "deadbeef";
const SHA1 = `${TEST_PREFIX}${"a".repeat(56)}`;
const SHA2 = `${TEST_PREFIX}${"b".repeat(56)}`;
const SHA3 = `${TEST_PREFIX}${"c".repeat(56)}`;
const MOD_SLUG_A = "p7-media-test-a";
const MOD_SLUG_B = "p7-media-test-b";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM modules WHERE slug IN (${MOD_SLUG_A}, ${MOD_SLUG_B})`;
      await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${TEST_PREFIX}%`}`;
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
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

function uploadInput(sha: string, alt = ""): Parameters<typeof execute>[4] {
  return {
    sha256: sha,
    originalName: `${sha.slice(0, 8)}.jpg`,
    mime: "image/jpeg",
    sizeBytes: 12345,
    width: 1920,
    height: 1080,
    alt,
    storageKey: `${sha}/orig.jpg`,
    variants: [
      {
        variant: "orig",
        format: "jpeg",
        width: 1920,
        height: 1080,
        sizeBytes: 12345,
        storageKey: `${sha}/orig.jpg`,
      },
      {
        variant: "webp-800",
        format: "webp",
        width: 800,
        height: 450,
        sizeBytes: 4567,
        storageKey: `${sha}/webp-800.webp`,
      },
    ],
  };
}

describe("P7 media ops", () => {
  it("media.upload inserts an asset with variants and returns a stable id", async () => {
    const r = await execute(
      registry,
      adapter,
      systemCtx,
      "media.upload",
      uploadInput(SHA1, "alt 1"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { deduped: boolean }).deduped).toBe(false);

    const get = await execute(registry, adapter, systemCtx, "media.get", {
      assetId: (r.value as { assetId: string }).assetId,
    });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const asset = (
      get.value as { asset: { sha256: string; variants: { variant: string }[] } | null }
    ).asset!;
    expect(asset.sha256).toBe(SHA1);
    expect(asset.variants.map((v) => v.variant).sort()).toEqual(["orig", "webp-800"]);
  });

  it("re-uploading the same sha is deduped (no second row)", async () => {
    const r = await execute(
      registry,
      adapter,
      systemCtx,
      "media.upload",
      uploadInput(SHA1, "alt 1"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { deduped: boolean }).deduped).toBe(true);

    const list = await execute(registry, adapter, systemCtx, "media.list", {
      limit: 60,
      offset: 0,
    });
    if (!list.ok) {
      console.error("media.list error", JSON.stringify(list.error, null, 2));
    }
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const seen = (list.value as { assets: { sha256: string }[] }).assets.filter(
      (a) => a.sha256 === SHA1,
    );
    expect(seen.length).toBe(1);
  });

  it("media.update_alt updates the alt field", async () => {
    const list = await execute(registry, adapter, systemCtx, "media.list", {
      limit: 60,
      offset: 0,
    });
    if (!list.ok) throw new Error("list failed");
    const target = (list.value as { assets: { id: string; sha256: string }[] }).assets.find(
      (a) => a.sha256 === SHA1,
    );
    expect(target).toBeDefined();
    if (!target) return;

    const r = await execute(registry, adapter, systemCtx, "media.update_alt", {
      assetId: target.id,
      alt: "new alt text",
    });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "media.get", { assetId: target.id });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect((get.value as { asset: { alt: string } }).asset.alt).toBe("new alt text");
  });

  it("usage tracker bumps usage_count when a module's HTML adds a media URL", async () => {
    const list = await execute(registry, adapter, systemCtx, "media.list", {
      limit: 60,
      offset: 0,
    });
    if (!list.ok) throw new Error("list failed");
    const target = (list.value as { assets: { id: string; sha256: string }[] }).assets.find(
      (a) => a.sha256 === SHA1,
    );
    if (!target) throw new Error("target not seeded");
    const assetId = target.id;

    // Create a module with an empty body.
    const create = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG_A,
      displayName: "test",
      html: "<p>placeholder</p>",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const before = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    if (!before.ok) throw new Error("before get failed");
    const beforeCount = (before.value as { asset: { usageCount: number } }).asset.usageCount;

    // Add a media URL via update.
    const upd = await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      html: `<p>hi</p><img src="/_caelo/media/${assetId}/webp-800" alt="x" />`,
    });
    expect(upd.ok).toBe(true);

    const after = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    if (!after.ok) throw new Error("after get failed");
    const afterCount = (after.value as { asset: { usageCount: number } }).asset.usageCount;
    expect(afterCount).toBe(beforeCount + 1);

    // Remove the media URL — count goes back down.
    const upd2 = await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      html: "<p>hi again</p>",
    });
    expect(upd2.ok).toBe(true);
    const after2 = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    if (!after2.ok) throw new Error("after2 get failed");
    const after2Count = (after2.value as { asset: { usageCount: number } }).asset.usageCount;
    expect(after2Count).toBe(beforeCount);
  });

  it("media.delete blocks without force when usage_count > 0; succeeds with force", async () => {
    // Upload SHA2; create a module that references it; try to delete.
    const up = await execute(registry, adapter, systemCtx, "media.upload", uploadInput(SHA2));
    if (!up.ok) throw new Error("up failed");
    const assetId = (up.value as { assetId: string }).assetId;

    const create = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG_B,
      displayName: "test b",
      html: `<img src="/_caelo/media/${assetId}/orig" alt="x" />`,
    });
    expect(create.ok).toBe(true);

    const blocked = await execute(registry, adapter, systemCtx, "media.delete", {
      assetId,
      force: false,
    });
    expect(blocked.ok).toBe(false);

    const forced = await execute(registry, adapter, systemCtx, "media.delete", {
      assetId,
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(
      (forced.value as { referencingModules: { slug: string }[] }).referencingModules.length,
    ).toBeGreaterThan(0);
  });

  it("media.recent_for_ai returns deduped recent + popular", async () => {
    const r = await execute(registry, adapter, systemCtx, "media.recent_for_ai", { limit: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value as { assets: { id: string }[] }).assets.map((a) => a.id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });

  it("media.get_settings returns defaults when site_defaults singleton is seeded", async () => {
    const r = await execute(registry, adapter, systemCtx, "media.get_settings", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { cdnCopyEnabled: boolean; cdnUsageThreshold: number };
    expect(typeof v.cdnCopyEnabled).toBe("boolean");
    expect(v.cdnUsageThreshold).toBeGreaterThanOrEqual(1);
  });
});
