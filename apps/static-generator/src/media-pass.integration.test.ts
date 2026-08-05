// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — static-generator media pass unit-ish test. Uses a real Postgres
 * tx to exercise the SQL paths but writes filesystem to a tmp dir.
 *
 * Verifies:
 *   - URLs in pages get rewritten from /_caelo/media/... to /_assets/...
 *   - referenced variant bytes are copied to <buildDir>/_assets/...
 *   - cdn_manifest.json is always emitted
 *   - missing asset/variant references throw a structured error
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runMediaPass } from "./media-pass.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TEST_PREFIX = "f7d77ed0";
const SHA = `${TEST_PREFIX}${"a".repeat(56)}`;
// Second seed asset: orig + a webp breakpoint ladder, for the srcset case.
const HERO_SHA = `${TEST_PREFIX}${"b".repeat(56)}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let mediaRoot: string;
let buildDir: string;
let assetId = "";
let assetSlug = "";
let heroSlug = "";

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-pass-test",
};

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

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  // mkdtempSync creates a uniquely-named dir (random suffix, mode 0700)
  // atomically — no predictable path in the world-readable temp dir
  // (CodeQL js/insecure-temporary-file).
  mediaRoot = mkdtempSync(join(tmpdir(), "caelo-media-pass-"));
  buildDir = mkdtempSync(join(tmpdir(), "caelo-media-pass-build-"));

  // Seed an asset row + a fake `orig.png` blob in mediaRoot at the
  // expected storage key. `name` drives the public slug.
  const upload = await execute(registry, adapter, systemCtx, "media.upload", {
    sha256: SHA,
    originalName: "test.png",
    name: "SearchVIU Logo",
    mime: "image/png",
    sizeBytes: 4,
    width: null,
    height: null,
    alt: "",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: null,
        height: null,
        sizeBytes: 4,
        storageKey: `${SHA}/orig.png`,
      },
    ],
  });
  if (!upload.ok) throw new Error("seed upload failed");
  assetId = (upload.value as { assetId: string }).assetId;
  assetSlug = (upload.value as { slug: string }).slug;

  // Write a fake blob at the storage key so the copy step has bytes.
  await mkdir(join(mediaRoot, SHA), { recursive: true });
  await writeFile(join(mediaRoot, SHA, "orig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // Seed a second asset with a webp breakpoint ladder (orig + webp-400 +
  // webp-800) so the srcset enrichment has >= 2 same-family variants.
  const heroVariants = [
    { variant: "orig", format: "jpeg", storageKey: `${HERO_SHA}/orig.jpg` },
    { variant: "webp-400", format: "webp", storageKey: `${HERO_SHA}/webp-400.webp` },
    { variant: "webp-800", format: "webp", storageKey: `${HERO_SHA}/webp-800.webp` },
  ];
  const heroUpload = await execute(registry, adapter, systemCtx, "media.upload", {
    sha256: HERO_SHA,
    originalName: "hero.jpg",
    name: "SearchVIU Hero",
    mime: "image/jpeg",
    sizeBytes: 4,
    width: 1600,
    height: 900,
    alt: "",
    storageKey: `${HERO_SHA}/orig.jpg`,
    variants: heroVariants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.variant === "webp-400" ? 400 : v.variant === "webp-800" ? 800 : 1600,
      height: null,
      sizeBytes: 4,
      storageKey: v.storageKey,
    })),
  });
  if (!heroUpload.ok) throw new Error("hero seed upload failed");
  heroSlug = (heroUpload.value as { slug: string }).slug;

  await mkdir(join(mediaRoot, HERO_SHA), { recursive: true });
  for (const v of heroVariants) {
    const rel = v.storageKey.slice(HERO_SHA.length + 1);
    await writeFile(join(mediaRoot, HERO_SHA, rel), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("media-pass", () => {
  it("rewrites a slug orig embed to the FLAT _assets/<slug>.<ext> URL and copies bytes", async () => {
    const pages = [
      {
        html: `<img src="/_caelo/media/${assetSlug}" alt="x" />`,
        pageSlug: "test",
      },
    ];
    await adapter.withAdminTransaction(systemCtx, async (tx) => {
      await runMediaPass({
        tx,
        buildDir,
        pages,
        mediaRoot,
        settings: { cdnEnabled: false, threshold: 5 },
      });
    });
    // Slug orig → flat file, meaningful name, id nowhere in the URL.
    expect(pages[0]?.html).toContain(`/_assets/${assetSlug}.png`);
    expect(pages[0]?.html).not.toContain("/_caelo/media");
    expect(pages[0]?.html).not.toContain(assetId);

    const copied = await readFile(join(buildDir, "_assets", `${assetSlug}.png`));
    expect(copied.byteLength).toBe(4);

    const manifest = JSON.parse(await readFile(join(buildDir, "cdn_manifest.json"), "utf8")) as {
      enabled: boolean;
      entries: unknown[];
    };
    expect(manifest.enabled).toBe(false);
    expect(manifest.entries).toEqual([]);
  });

  it("nests a named variant under the slug and adds a webp srcset (_assets/<slug>/webp-800.webp)", async () => {
    const pages = [
      {
        html: `<img src="/_caelo/media/${heroSlug}/webp-800" alt="hero" />`,
        pageSlug: "hero-page",
      },
    ];
    await adapter.withAdminTransaction(systemCtx, async (tx) => {
      await runMediaPass({
        tx,
        buildDir,
        pages,
        mediaRoot,
        settings: { cdnEnabled: false, threshold: 5 },
      });
    });
    const html = pages[0]?.html ?? "";
    // src rewritten to the nested variant path.
    expect(html).toContain(`src="/_assets/${heroSlug}/webp-800.webp"`);
    // >= 2 same-family webp variants → responsive srcset spanning the ladder.
    expect(html).toContain("srcset=");
    expect(html).toContain(`/_assets/${heroSlug}/webp-400.webp 400w`);
    expect(html).toContain(`/_assets/${heroSlug}/webp-800.webp 800w`);
    expect(html).not.toContain("/_caelo/media");

    const copied = await readFile(join(buildDir, "_assets", heroSlug, "webp-800.webp"));
    expect(copied.byteLength).toBe(4);
  });

  it("keeps the legacy _assets/<id>/<variant>.<ext> shape for a legacy uuid embed", async () => {
    const pages = [
      {
        html: `<img src="/_caelo/media/${assetId}/orig" alt="legacy" />`,
        pageSlug: "legacy-page",
      },
    ];
    await adapter.withAdminTransaction(systemCtx, async (tx) => {
      await runMediaPass({
        tx,
        buildDir,
        pages,
        mediaRoot,
        settings: { cdnEnabled: false, threshold: 5 },
      });
    });
    // Legacy id form keeps the nested id path (no flattening).
    expect(pages[0]?.html).toContain(`/_assets/${assetId}/orig.png`);
    expect(pages[0]?.html).not.toContain("/_caelo/media");

    const copied = await readFile(join(buildDir, "_assets", assetId, "orig.png"));
    expect(copied.byteLength).toBe(4);
  });

  it("populates cdn_manifest.entries when enabled and asset usage clears the threshold", async () => {
    // Bump usage_count above the threshold via raw update — easier than
    // simulating a real module reference cycle.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE media_assets SET usage_count = 10 WHERE id = ${assetId}::uuid`;
      });
    } finally {
      await sql.end();
    }

    const pages = [
      {
        html: `<img src="/_caelo/media/${assetSlug}" alt="x" />`,
        pageSlug: "test",
      },
    ];
    await adapter.withAdminTransaction(systemCtx, async (tx) => {
      await runMediaPass({
        tx,
        buildDir,
        pages,
        mediaRoot,
        settings: { cdnEnabled: true, threshold: 5 },
      });
    });
    const manifest = JSON.parse(await readFile(join(buildDir, "cdn_manifest.json"), "utf8")) as {
      enabled: boolean;
      entries: { assetId: string; variant: string }[];
    };
    expect(manifest.enabled).toBe(true);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.entries[0]?.assetId).toBe(assetId);
  });

  it("throws when a page references an asset/variant that doesn't exist", async () => {
    const pages = [
      {
        html: `<img src="/_caelo/media/00000000-0000-0000-0000-000000000000/webp-800" alt="x" />`,
        pageSlug: "broken",
      },
    ];
    let thrown: unknown = null;
    try {
      await adapter.withAdminTransaction(systemCtx, async (tx) => {
        await runMediaPass({
          tx,
          buildDir,
          pages,
          mediaRoot,
          settings: { cdnEnabled: false, threshold: 5 },
        });
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("media references unresolved");
    // run #10 D4 — the failure surface must carry the recovery step
    // (CLAUDE.md §11), not just the diagnosis.
    expect((thrown as Error).message).toContain("regenerate_media_variants");
  });
});
