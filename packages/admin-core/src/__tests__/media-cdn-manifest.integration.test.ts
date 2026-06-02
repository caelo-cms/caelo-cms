// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — CDN-copy toggle controls cdn_manifest.json contents.
 *
 *  - When OFF: manifest is always written, but `entries` is empty.
 *  - When ON: every (asset, variant) used at least `threshold` times
 *    appears in `entries` with size + outputPath.
 *
 * The actual cloud upload + URL rewrite to a CDN domain is the P15
 * adapter's job; P7 ships the manifest only. This test verifies
 * the manifest contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runMediaPass } from "../../../../apps/static-generator/src/media-pass.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TEST_PREFIX = "cdba9002";
const SHA = `${TEST_PREFIX}${"a".repeat(56)}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let mediaRoot: string;
let buildDir: string;
let assetId = "";

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-cdn-test",
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
  // mkdtempSync: unique dir, random suffix, mode 0700, created atomically
  // (CodeQL js/insecure-temporary-file).
  mediaRoot = mkdtempSync(join(tmpdir(), "caelo-cdn-test-"));
  buildDir = mkdtempSync(join(tmpdir(), "caelo-cdn-build-"));

  const upload = await execute(registry, adapter, systemCtx, "media.upload", {
    sha256: SHA,
    originalName: "cdn-test.png",
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
  await mkdir(join(mediaRoot, SHA), { recursive: true });
  await writeFile(join(mediaRoot, SHA, "orig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // Bump usage so the asset clears the threshold in the second test.
  const bump = new SQL(ADMIN_URL!);
  try {
    await bump.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE media_assets SET usage_count = 10 WHERE id = ${assetId}::uuid`;
    });
  } finally {
    await bump.end();
  }
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("P7 CDN manifest", () => {
  it("OFF → cdn_manifest.json has empty entries", async () => {
    const pages = [
      { html: `<img src="/_caelo/media/${assetId}/orig" alt="x" />`, pageSlug: "test" },
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
    const manifest = JSON.parse(await readFile(join(buildDir, "cdn_manifest.json"), "utf8")) as {
      enabled: boolean;
      entries: unknown[];
    };
    expect(manifest.enabled).toBe(false);
    expect(manifest.entries).toEqual([]);
  });

  it("ON + usage >= threshold → asset appears in manifest entries", async () => {
    const pages = [
      { html: `<img src="/_caelo/media/${assetId}/orig" alt="x" />`, pageSlug: "test" },
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
      threshold: number;
      entries: { assetId: string; variant: string; bytes: number; usageCount: number }[];
    };
    expect(manifest.enabled).toBe(true);
    expect(manifest.threshold).toBe(5);
    expect(manifest.entries.length).toBeGreaterThan(0);
    const entry = manifest.entries.find((e) => e.assetId === assetId);
    expect(entry).toBeDefined();
    expect(entry?.usageCount).toBeGreaterThanOrEqual(5);
    expect(entry?.bytes).toBeGreaterThan(0);
  });
});
