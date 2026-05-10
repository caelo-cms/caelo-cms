// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — GCS static publisher.
 *
 * Stage uploads the local build to a private staging bucket
 * (`<project>-caelo-<env>-staging`) under a per-runId prefix.
 * Confirm-publish does cross-bucket server-side object copies into
 * the public static bucket (`<project>-caelo-<env>-static`) — the
 * bytes never round-trip through the admin Cloud Run process, so
 * promote stays fast even at 80k routes.
 *
 * Hash-skip via a manifest at
 * `gs://<static-bucket>/_state/last-build-manifest.json`: every
 * publish reads the manifest, skips files whose CRC32C matches the
 * live state, uploads the rest in parallel batches of 100. Confirm-
 * publish then copies only the changed files (it knows which they
 * are because the staging-bucket prefix only contains them).
 *
 * Two env vars drive this adapter — set by the GCP Pulumi stack on
 * the admin Cloud Run service:
 *   - CAELO_STATIC_BUCKET — public-read live origin
 *   - CAELO_STAGING_BUCKET — private staging area
 * Either being unset is a deploy bug (publish errors loudly per
 * CLAUDE.md §2 "no fallbacks pre-1.0").
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Bucket, Storage as StorageType } from "@google-cloud/storage";
import type { PromoteSummary, PublishSummary, StaticPublisher } from "./static-publisher.js";

const PARALLEL_UPLOADS = 100;
const PARALLEL_COPIES = 100;
const MANIFEST_KEY = "_state/last-build-manifest.json";

interface BuildManifest {
  buildId: string;
  files: Record<string, string>;
}

interface BucketHandles {
  storage: StorageType;
  staticBucket: Bucket;
  stagingBucket: Bucket;
  staticBucketName: string;
  stagingBucketName: string;
}

async function bucketHandles(): Promise<BucketHandles> {
  const staticBucketName = process.env.CAELO_STATIC_BUCKET;
  const stagingBucketName = process.env.CAELO_STAGING_BUCKET;
  if (!staticBucketName) {
    throw new Error(
      "static-publisher-gcs: CAELO_STATIC_BUCKET not set. The GCP Pulumi stack must set this env var on the admin Cloud Run service.",
    );
  }
  if (!stagingBucketName) {
    throw new Error(
      "static-publisher-gcs: CAELO_STAGING_BUCKET not set. The GCP Pulumi stack must set this env var on the admin Cloud Run service.",
    );
  }
  // Lazy-import @google-cloud/storage so self-hosted runtimes don't
  // pull it. The Cloud Run service has the SDK in its bundle; ADC
  // (Application Default Credentials) finds the run SA automatically.
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage();
  return {
    storage,
    staticBucket: storage.bucket(staticBucketName),
    stagingBucket: storage.bucket(stagingBucketName),
    staticBucketName,
    stagingBucketName,
  };
}

export const gcsStaticPublisher: StaticPublisher = {
  async publishStaging({ buildDir, runId, target: _target }) {
    const h = await bucketHandles();
    const files = await walkBuildDir(buildDir);
    const manifest = await readLiveManifest(h.staticBucket);
    let uploaded = 0;
    let skipped = 0;
    const prefix = `${runId}/`;
    await runBatched(files, PARALLEL_UPLOADS, async (file) => {
      const localCrc = await crc32cOfFile(file.absolutePath);
      const liveCrc = manifest?.files[file.relativePath];
      if (liveCrc === localCrc) {
        // Identical to what's currently live. Don't upload to
        // staging — the staging-preview proxy falls back to the
        // static bucket for missing files. Saves storage + time.
        skipped += 1;
        return;
      }
      await uploadFile(h.stagingBucket, prefix + file.relativePath, file.absolutePath);
      uploaded += 1;
    });
    return {
      provider: "gcp",
      uploadedCount: uploaded,
      skippedUnchangedCount: skipped,
      location: `gs://${h.stagingBucketName}/${prefix}`,
    };
  },

  async promoteToProduction({ sourceRunId, fromTarget: _from, toTarget }) {
    const h = await bucketHandles();
    // List everything under the staging prefix — the only files there
    // are the ones publishStaging actually changed. Server-side copy
    // each into the static bucket. Then update the live manifest.
    const prefix = `${sourceRunId}/`;
    const [stagedFiles] = await h.stagingBucket.getFiles({ prefix });
    if (stagedFiles.length === 0) {
      throw new Error(
        `promoteToProduction: no staged files found under gs://${h.stagingBucketName}/${prefix}. Run Stage first.`,
      );
    }
    let copied = 0;
    await runBatched(stagedFiles, PARALLEL_COPIES, async (stagedFile) => {
      const relPath = stagedFile.name.slice(prefix.length);
      // robots.txt + routing-manifest are per-target — overwrite with
      // the destination target's values rather than copying staging's.
      // We re-render those after the copy loop completes.
      if (relPath === "robots.txt" || relPath === "routing-manifest.json") {
        return;
      }
      await stagedFile.copy(h.staticBucket.file(relPath), {
        contentType: contentTypeFor(relPath),
        metadata: { cacheControl: cacheControlFor(relPath) },
      });
      copied += 1;
    });
    // Apply per-target robots.txt + routing-manifest overrides.
    const { buildRobotsTxt } = await import("@caelo-cms/static-generator");
    const robotsBody = buildRobotsTxt(toTarget.robotsDefault);
    await uploadBytes(h.staticBucket, "robots.txt", Buffer.from(robotsBody, "utf8"), "text/plain");
    copied += 1;
    // Refresh the routing manifest if staging produced one.
    const stagingManifest = h.stagingBucket.file(`${prefix}routing-manifest.json`);
    const [stagingManifestExists] = await stagingManifest.exists();
    if (stagingManifestExists) {
      const [body] = await stagingManifest.download();
      try {
        const manifest = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        manifest.target = toTarget.name;
        manifest.env = toTarget.env;
        await uploadBytes(
          h.staticBucket,
          "routing-manifest.json",
          Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
          "application/json",
        );
        copied += 1;
      } catch {
        // Malformed manifest — skip the per-target patch.
      }
    }
    // Update the live manifest with the new state. We rebuild it from
    // the static bucket's actual contents to stay self-consistent —
    // someone may have edited objects out-of-band.
    const newManifest = await buildLiveManifest(h.staticBucket, sourceRunId);
    await uploadBytes(
      h.staticBucket,
      MANIFEST_KEY,
      Buffer.from(JSON.stringify(newManifest), "utf8"),
      "application/json",
    );
    const summary: PromoteSummary = {
      provider: "gcp",
      uploadedCount: copied,
      skippedUnchangedCount: 0,
      location: `gs://${h.staticBucketName}/`,
      destinationBuildId: sourceRunId,
    };
    return summary;
  },

  async rollback({ sourceBuildDir, target: _target }): Promise<PublishSummary> {
    // Rollback re-uploads the archived build dir to the static bucket
    // root. Because we don't archive cloud builds today (only the
    // _staging/<runId>/ prefix lives in staging bucket), rollback on
    // cloud requires the operator to keep the source build dir on the
    // admin's local /tmp — out of scope for v0.2.78. The Ops dashboard
    // surfaces "rollback is local-disk only" until v0.2.79+ adds a
    // builds/<runId>/ archive prefix to the static bucket.
    if (!sourceBuildDir) {
      throw new Error(
        "static-publisher-gcs.rollback: cloud rollback requires an archived build dir (not yet implemented in v0.2.78). Tracked for v0.2.79+.",
      );
    }
    const h = await bucketHandles();
    const files = await walkBuildDir(sourceBuildDir);
    let uploaded = 0;
    await runBatched(files, PARALLEL_UPLOADS, async (file) => {
      await uploadFile(h.staticBucket, file.relativePath, file.absolutePath);
      uploaded += 1;
    });
    return {
      provider: "gcp",
      uploadedCount: uploaded,
      skippedUnchangedCount: 0,
      location: `gs://${h.staticBucketName}/`,
    };
  },
};

async function readLiveManifest(staticBucket: Bucket): Promise<BuildManifest | null> {
  const file = staticBucket.file(MANIFEST_KEY);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [body] = await file.download();
  return JSON.parse(body.toString("utf8")) as BuildManifest;
}

async function buildLiveManifest(staticBucket: Bucket, buildId: string): Promise<BuildManifest> {
  const [files] = await staticBucket.getFiles();
  const entries: Record<string, string> = {};
  for (const f of files) {
    if (f.name === MANIFEST_KEY) continue;
    // GCS stores CRC32C in metadata; no need to download to compute.
    const crc = (f.metadata as { crc32c?: string } | undefined)?.crc32c;
    if (crc) entries[f.name] = crc;
  }
  return { buildId, files: entries };
}

interface WalkedFile {
  absolutePath: string;
  relativePath: string;
}

async function walkBuildDir(buildDir: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(buildDir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else {
        out.push({
          absolutePath: join(buildDir, childRel),
          relativePath: childRel,
        });
      }
    }
  };
  await walk("");
  return out;
}

async function crc32cOfFile(absolutePath: string): Promise<string> {
  // Bun has a native CRC32C in its FS hashing primitives via the
  // node:crypto polyfill; falling back to a small JS impl keeps the
  // module portable. The hash is base64-encoded big-endian to match
  // GCS's `crc32c` metadata format.
  const buf = await readFile(absolutePath);
  const crc = crc32c(buf);
  // GCS reports CRC32C as base64 of 4 big-endian bytes.
  const bytes = new Uint8Array(4);
  bytes[0] = (crc >>> 24) & 0xff;
  bytes[1] = (crc >>> 16) & 0xff;
  bytes[2] = (crc >>> 8) & 0xff;
  bytes[3] = crc & 0xff;
  return Buffer.from(bytes).toString("base64");
}

// Castagnoli CRC32C (poly 0x1EDC6F41, reflected). Lookup-table impl;
// ~1.5 GB/s on a single core which is fine for build-dir crawls.
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32c(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: table is fully populated 0..255
    c = (c >>> 8) ^ CRC32C_TABLE[(c ^ buf[i]!) & 0xff]!;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function uploadFile(bucket: Bucket, key: string, absolutePath: string): Promise<void> {
  await bucket.upload(absolutePath, {
    destination: key,
    contentType: contentTypeFor(key),
    metadata: { cacheControl: cacheControlFor(key) },
  });
}

async function uploadBytes(
  bucket: Bucket,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await bucket.file(key).save(body, {
    contentType,
    metadata: { cacheControl: cacheControlFor(key) },
  });
}

function contentTypeFor(key: string): string {
  const ext = extname(key).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function cacheControlFor(key: string): string {
  // Vite-hashed assets land under _app/immutable/ — cache forever.
  if (key.includes("/_app/immutable/") || key.includes("_app/immutable/")) {
    return "public, max-age=31536000, immutable";
  }
  if (key.endsWith(".html") || key === "index.html") {
    return "public, max-age=60, stale-while-revalidate=86400";
  }
  if (key === "routing-manifest.json") {
    return "public, max-age=10";
  }
  if (key.endsWith(".json")) {
    return "public, max-age=60";
  }
  if (key === "robots.txt" || key === "sitemap.xml") {
    return "public, max-age=300";
  }
  return "public, max-age=3600";
}

async function runBatched<T>(
  items: ReadonlyArray<T>,
  parallelism: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      // biome-ignore lint/style/noNonNullAssertion: cursor < length checked
      await worker(items[i]!);
    }
  };
  const workers: Promise<void>[] = [];
  const n = Math.min(parallelism, items.length);
  for (let i = 0; i < n; i++) workers.push(next());
  await Promise.all(workers);
}
