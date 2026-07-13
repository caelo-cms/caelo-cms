// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D4 — `media.regenerate_variants` integration tests.
 *
 * The live failure: five migrated assets had ONLY their `orig` variant,
 * module HTML referenced `<id>/webp-800`, and the staging generator
 * hard-blocked with no recovery path. These tests exercise the recovery
 * op against a real Postgres + a real on-disk storage root:
 *
 *  - an asset with a closable gap gets its missing WebP variants minted
 *    (bytes on disk + media_variants rows), additively;
 *  - a source narrower than a breakpoint never gains that breakpoint
 *    (no upscaling) and the per-asset report says to use /orig instead;
 *  - re-running reports `complete` (idempotent, no duplicate rows);
 *  - allMissing mode finds gap assets without explicit ids;
 *  - unknown ids come back as loud `not_found` entries, not silence.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import sharp from "sharp";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let storageRoot: string;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-regenerate-integration-test",
};

const TEST_PREFIX = "regen000";
const SHA_WIDE = `${TEST_PREFIX}${"a".repeat(56)}`;
const SHA_TINY = `${TEST_PREFIX}${"b".repeat(56)}`;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${TEST_PREFIX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

/** Upload an asset that has ONLY its orig variant — the run #10 state. */
async function seedOrigOnlyAsset(args: {
  sha: string;
  width: number;
  height: number;
}): Promise<string> {
  const storage = new LocalVolumeAdapter(storageRoot);
  const bytes = new Uint8Array(
    await sharp({
      create: {
        width: args.width,
        height: args.height,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    })
      .png()
      .toBuffer(),
  );
  const storageKey = `${args.sha}/orig.png`;
  await storage.put(storageKey, bytes, "image/png");
  const r = await execute(registry, adapter, systemCtx, "media.upload", {
    sha256: args.sha,
    // slice(0,12) — the shared TEST_PREFIX is 8 chars, so 8 would name
    // every seeded asset identically and break the list-by-name lookup.
    originalName: `${args.sha.slice(0, 12)}.png`,
    mime: "image/png",
    sizeBytes: bytes.byteLength,
    width: args.width,
    height: args.height,
    alt: "",
    storageKey,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: args.width,
        height: args.height,
        sizeBytes: bytes.byteLength,
        storageKey,
      },
    ],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("seed upload failed");
  return (r.value as { assetId: string }).assetId;
}

beforeAll(async () => {
  await wipe();
  storageRoot = mkdtempSync(join(tmpdir(), "caelo-regen-test-"));
  setMediaStorage(new LocalVolumeAdapter(storageRoot), "local");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

type RegenResult = {
  assetId: string;
  status: string;
  addedVariants: string[];
  reason: string | null;
  bestUrl: string | null;
};

describe("media.regenerate_variants (run #10 D4)", () => {
  it("mints the missing satisfiable WebP variants and skips unsatisfiable breakpoints", async () => {
    const assetId = await seedOrigOnlyAsset({ sha: SHA_WIDE, width: 600, height: 300 });

    const r = await execute(registry, adapter, systemCtx, "media.regenerate_variants", {
      assetIds: [assetId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const results = (r.value as { results: RegenResult[] }).results;
    expect(results).toHaveLength(1);
    const result = results[0]!;
    // 600px source: webp-400 is satisfiable, webp-800 is NOT (no upscaling).
    expect(result.status).toBe("regenerated");
    expect(result.addedVariants).toEqual(["webp-400"]);
    expect(result.bestUrl).toBe(`/_caelo/media/${assetId}/webp-400`);

    const get = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const variants = (
      get.value as { asset: { variants: { variant: string; storageKey: string }[] } }
    ).asset.variants.map((v) => v.variant);
    expect(variants.sort()).toEqual(["orig", "webp-400"]);

    // New variant bytes actually landed in storage.
    const storage = new LocalVolumeAdapter(storageRoot);
    expect(await storage.exists(`${SHA_WIDE}/webp-400.webp`)).toBe(true);
  });

  it("re-running reports complete and adds nothing (idempotent)", async () => {
    const list = await execute(registry, adapter, systemCtx, "media.list", {
      query: SHA_WIDE.slice(0, 12),
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const assetId = (list.value as { assets: { id: string }[] }).assets[0]!.id;

    const r = await execute(registry, adapter, systemCtx, "media.regenerate_variants", {
      assetIds: [assetId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = (r.value as { results: RegenResult[] }).results[0]!;
    expect(result.status).toBe("complete");
    expect(result.addedVariants).toEqual([]);
  });

  it("explains sub-400px sources with an /orig pointer instead of looping", async () => {
    const assetId = await seedOrigOnlyAsset({ sha: SHA_TINY, width: 180, height: 90 });

    const r = await execute(registry, adapter, systemCtx, "media.regenerate_variants", {
      assetIds: [assetId],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = (r.value as { results: RegenResult[] }).results[0]!;
    expect(result.status).toBe("skipped");
    expect(result.addedVariants).toEqual([]);
    expect(result.reason).toContain("/orig");
    expect(result.bestUrl).toBe(`/_caelo/media/${assetId}/orig`);
  });

  it("allMissing sweep finds gap assets without explicit ids", async () => {
    // SHA_TINY's asset is complete-by-design (nothing satisfiable), the
    // SHA_WIDE asset was already fixed — seed a fresh gap to detect.
    const shaGap = `${TEST_PREFIX}${"c".repeat(56)}`;
    const assetId = await seedOrigOnlyAsset({ sha: shaGap, width: 1000, height: 500 });

    const r = await execute(registry, adapter, systemCtx, "media.regenerate_variants", {
      allMissing: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const results = (r.value as { results: RegenResult[] }).results;
    const mine = results.find((x) => x.assetId === assetId);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe("regenerated");
    expect(mine!.addedVariants.sort()).toEqual(["webp-400", "webp-800"]);
  });

  it("reports unknown asset ids as not_found instead of dropping them", async () => {
    const r = await execute(registry, adapter, systemCtx, "media.regenerate_variants", {
      assetIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = (r.value as { results: RegenResult[] }).results[0]!;
    expect(result.status).toBe("not_found");
    expect(result.reason).toContain("media.list");
  });
});
