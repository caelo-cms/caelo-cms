// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the stored media digests are derived state (#1267 rule 3):
 *
 *   - consistency: every write path stores, with each variant, the digests
 *     of the file it stored (upload through the pipeline, variant
 *     regeneration, the favicon rendition);
 *   - backfill: `media.rebuild_digests` (scope "missing", what every Stage
 *     runs before the generator) fills rows that have none;
 *   - rebuild: scope "all" recomputes every row and reports what was wrong;
 *     a row whose file is gone is reported, not guessed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { link, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, FAVICON_VARIANT } from "@caelo-cms/shared";
import { digestBytes, digestFile } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import sharp from "sharp";
import { runMediaPipeline } from "../media/pipeline.js";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { ensureFaviconRendition } from "../ops/media_favicon.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-digests-test",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let storageRoot: string;
let assetId = "";
let origOnlyId = "";

interface Row {
  asset_id: string;
  variant: string;
  storage_key: string;
  content_sha256: string | null;
  gzip_sha256: string | null;
  gzip_size: string | number | null;
  digest_profile: string | null;
}

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

async function rows(ids: string[]): Promise<Row[]> {
  return (await asSystem(
    (tx) => tx`
      SELECT asset_id::text AS asset_id, variant, storage_key, content_sha256, gzip_sha256,
             gzip_size, digest_profile
      FROM media_variants WHERE asset_id IN ${tx(ids)} ORDER BY asset_id, variant`,
  )) as Row[];
}

/** Every row's stored digests equal the digests of the file it names. */
async function expectConsistent(ids: string[]): Promise<void> {
  const all = await rows(ids);
  expect(all.length).toBeGreaterThan(0);
  for (const r of all) {
    const d = await digestFile(join(storageRoot, r.storage_key));
    expect({
      variant: r.variant,
      contentSha256: r.content_sha256,
      gzipSha256: r.gzip_sha256,
      gzipSize: Number(r.gzip_size),
      profile: r.digest_profile,
    }).toEqual({
      variant: r.variant,
      contentSha256: d.contentSha256,
      gzipSha256: d.gzipSha256,
      gzipSize: d.gzipSize,
      profile: d.profile,
    });
  }
}

async function png(width: number, height: number, r: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r, g: 90, b: 140 } } })
      .png()
      .toBuffer(),
  );
}

/** What the upload endpoint does: pipeline, store every variant, media.upload. */
async function upload(bytes: Uint8Array, only?: "orig"): Promise<string> {
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const storage = new LocalVolumeAdapter(storageRoot);
  const result = await runMediaPipeline(sha, "image/png", bytes);
  const variants = only ? result.variants.filter((v) => v.variant === only) : result.variants;
  for (const v of variants) await storage.put(v.storageKey, v.body, v.contentType);
  const up = await execute(registry, adapter, SYSTEM, "media.upload", {
    sha256: sha,
    originalName: `digest-${sha.slice(0, 8)}.png`,
    mime: "image/png",
    sizeBytes: bytes.byteLength,
    width: result.width,
    height: result.height,
    alt: "",
    storageKey: variants[0]?.storageKey ?? `${sha}/orig`,
    variants: variants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.width,
      height: v.height,
      sizeBytes: v.sizeBytes,
      storageKey: v.storageKey,
      digest: v.digest,
    })),
  });
  if (!up.ok) throw new Error(JSON.stringify(up.error));
  return (up.value as { assetId: string }).assetId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  storageRoot = mkdtempSync(join(tmpdir(), "caelo-media-digests-"));
  setMediaStorage(new LocalVolumeAdapter(storageRoot));
  assetId = await upload(await png(1700, 900, 20));
  origOnlyId = await upload(await png(1300, 700, 60), "orig");
});

afterAll(async () => {
  await asSystem((tx) => tx`DELETE FROM media_assets WHERE id IN ${tx([assetId, origOnlyId])}`);
  await adapter.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("media digests are stored by every write path (consistency)", () => {
  it("an upload stores each variant's digests", async () => {
    expect((await rows([assetId])).length).toBeGreaterThan(1);
    await expectConsistent([assetId]);
  });

  it("regenerated variants carry their digests", async () => {
    const r = await execute(registry, adapter, SYSTEM, "media.regenerate_variants", {
      assetIds: [origOnlyId],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((await rows([origOnlyId])).length).toBeGreaterThan(1);
    await expectConsistent([origOnlyId]);
  });

  it("the favicon rendition carries its digests", async () => {
    const sha = (
      (await asSystem((tx) => tx`SELECT sha256 FROM media_assets WHERE id = ${assetId}::uuid`)) as {
        sha256: string;
      }[]
    )[0]?.sha256 as string;
    await adapter.withAdminTransaction(SYSTEM, (tx) =>
      ensureFaviconRendition(tx, { id: assetId, sha256: sha, mime: "image/png" }),
    );
    expect((await rows([assetId])).some((r) => r.variant === FAVICON_VARIANT)).toBe(true);
    await expectConsistent([assetId]);
  });
});

describe("media.rebuild_digests (backfill and rebuild)", () => {
  it("scope missing fills rows written without digests (an older release, before 0452)", async () => {
    await asSystem(
      (tx) => tx`
        UPDATE media_variants
        SET content_sha256 = NULL, gzip_sha256 = NULL, gzip_size = NULL, digest_profile = NULL
        WHERE asset_id = ${assetId}::uuid`,
    );
    const r = await execute(registry, adapter, SYSTEM, "media.rebuild_digests", {
      scope: "missing",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const out = r.value as { updated: number; missingFiles: unknown[] };
    expect(out.updated).toBe((await rows([assetId])).length);
    expect(out.missingFiles).toEqual([]);
    await expectConsistent([assetId, origOnlyId]);
    // Nothing left to do: a second run touches nothing.
    const again = await execute(registry, adapter, SYSTEM, "media.rebuild_digests", {});
    expect(again.ok && (again.value as { checked: number }).checked).toBe(0);
  });

  it("scope all repairs a wrong digest and names it", async () => {
    const [first] = await rows([assetId]);
    await asSystem(
      (tx) => tx`
        UPDATE media_variants SET content_sha256 = ${"f".repeat(64)}
        WHERE asset_id = ${assetId}::uuid AND variant = ${first?.variant as string}`,
    );
    const r = await execute(registry, adapter, SYSTEM, "media.rebuild_digests", {
      scope: "all",
      assetIds: [assetId],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const out = r.value as { corrected: { assetId: string; variant: string }[]; updated: number };
    expect(out.corrected).toEqual([
      expect.objectContaining({ assetId, variant: first?.variant as string }),
    ]);
    expect(out.updated).toBe(1);
    await expectConsistent([assetId]);
  });

  it("reports a row whose file is gone instead of guessing its digest", async () => {
    const [first] = await rows([origOnlyId]);
    await asSystem(
      (tx) => tx`
        UPDATE media_variants
        SET content_sha256 = NULL, gzip_sha256 = NULL, gzip_size = NULL, digest_profile = NULL
        WHERE asset_id = ${origOnlyId}::uuid AND variant = ${first?.variant as string}`,
    );
    await unlink(join(storageRoot, first?.storage_key as string));
    const r = await execute(registry, adapter, SYSTEM, "media.rebuild_digests", {});
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((r.value as { missingFiles: { assetId: string }[] }).missingFiles).toEqual([
      expect.objectContaining({ assetId: origOnlyId, variant: first?.variant as string }),
    ]);
    const after = (await rows([origOnlyId])).find((x) => x.variant === first?.variant);
    expect(after?.content_sha256).toBeNull();
  });
});

describe("stored files and their digests stay one (#1271)", () => {
  it("a write replaces the stored file with a new one: a build's hard link keeps its bytes", async () => {
    const storage = new LocalVolumeAdapter(storageRoot);
    await storage.put("inode/test.bin", new Uint8Array([1, 2, 3]), "application/octet-stream");
    const linked = join(storageRoot, "linked.bin");
    await link(join(storageRoot, "inode/test.bin"), linked);
    await storage.put("inode/test.bin", new Uint8Array([9, 9]), "application/octet-stream");
    expect(new Uint8Array(await readFile(linked))).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await storage.get("inode/test.bin"))).toEqual(new Uint8Array([9, 9]));
  });

  it("a re-upload that rewrote the stored variants refreshes their digests", async () => {
    const [first] = await rows([assetId]);
    await asSystem(
      (tx) => tx`
        UPDATE media_variants SET content_sha256 = ${"e".repeat(64)}
        WHERE asset_id = ${assetId}::uuid AND variant = ${first?.variant as string}`,
    );
    const sha = (
      (await asSystem((tx) => tx`SELECT sha256 FROM media_assets WHERE id = ${assetId}::uuid`)) as {
        sha256: string;
      }[]
    )[0]?.sha256 as string;
    const file = join(storageRoot, first?.storage_key as string);
    const bytes = new Uint8Array(await readFile(file));
    const digest = await digestBytes(bytes);
    const r = await execute(registry, adapter, SYSTEM, "media.upload", {
      sha256: sha,
      originalName: "again.png",
      mime: "image/png",
      sizeBytes: bytes.byteLength,
      width: null,
      height: null,
      alt: "",
      storageKey: first?.storage_key as string,
      variants: [
        {
          variant: first?.variant as string,
          format: "png",
          width: null,
          height: null,
          sizeBytes: bytes.byteLength,
          storageKey: first?.storage_key as string,
          digest,
        },
      ],
    });
    expect(r.ok && (r.value as { deduped: boolean }).deduped).toBe(true);
    await expectConsistent([assetId]);
  });
});
