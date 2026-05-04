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

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let mediaRoot: string;
let buildDir: string;
let assetId = "";

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

  mediaRoot = join(tmpdir(), `caelo-media-pass-${Date.now()}`);
  buildDir = join(tmpdir(), `caelo-media-pass-build-${Date.now()}`);
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  // Seed an asset row + a fake `orig.png` blob in mediaRoot at the
  // expected storage key.
  const upload = await execute(registry, adapter, systemCtx, "media.upload", {
    sha256: SHA,
    originalName: "test.png",
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

  // Write a fake blob at the storage key so the copy step has bytes.
  await mkdir(join(mediaRoot, SHA), { recursive: true });
  await writeFile(join(mediaRoot, SHA, "orig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("media-pass", () => {
  it("rewrites URLs and copies bytes; emits cdn_manifest with empty entries when off", async () => {
    const pages = [
      {
        html: `<img src="/_caelo/media/${assetId}/orig" alt="x" />`,
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
    expect(pages[0]?.html).toContain(`/_assets/${assetId}/orig.png`);
    expect(pages[0]?.html).not.toContain("/_caelo/media");

    const copied = await readFile(join(buildDir, "_assets", assetId, "orig.png"));
    expect(copied.byteLength).toBe(4);

    const manifest = JSON.parse(await readFile(join(buildDir, "cdn_manifest.json"), "utf8")) as {
      enabled: boolean;
      entries: unknown[];
    };
    expect(manifest.enabled).toBe(false);
    expect(manifest.entries).toEqual([]);
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
        html: `<img src="/_caelo/media/${assetId}/orig" alt="x" />`,
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
  });
});
