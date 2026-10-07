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
import {
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  isContentHashedPath,
} from "@caelo-cms/shared";
import type { Bucket, Storage as StorageType } from "@google-cloud/storage";
import type { PromoteSummary, PublishSummary, StaticPublisher } from "./static-publisher.js";

const PARALLEL_UPLOADS = 100;
const PARALLEL_COPIES = 100;
const MANIFEST_KEY = "_state/last-build-manifest.json";

/**
 * Bump whenever `cacheControlForContentType` / `cacheControlFor`
 * change what an EXISTING object should carry. The hash-skip below
 * never re-uploads a byte-identical file, so content-hashed files
 * (fonts!) would keep the Cache-Control they were first uploaded with
 * forever. A live manifest stamped with an older policy version is
 * ignored, which makes the next Stage + Confirm-publish re-upload and
 * re-copy every file once with the current metadata.
 *
 *   1 — content-hashed fonts / plugin bundles immutable (Lighthouse
 *       uses-long-cache-ttl); promote keeps the staged Content-Type.
 */
export const CACHE_POLICY_VERSION = 1;

interface BuildManifest {
  buildId: string;
  files: Record<string, string>;
  /** Absent on manifests written before CACHE_POLICY_VERSION existed. */
  cachePolicyVersion?: number;
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
    // v0.2.85 — read the per-key Content-Type sidecar emitted by
    // the static-generator. Keys whose Content-Type can't be
    // inferred from extension (bare-slug pages in 'no-extension'
    // mode) are declared here; the publisher uses the override
    // before falling back to extension-based lookup.
    const contentTypeOverrides = await readContentTypeOverrides(buildDir);
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
      const contentType =
        contentTypeOverrides[file.relativePath] ?? contentTypeFor(file.relativePath);
      await uploadFile(h.stagingBucket, {
        key: prefix + file.relativePath,
        sitePath: file.relativePath,
        absolutePath: file.absolutePath,
        contentType,
      });
      uploaded += 1;
    });
    return {
      provider: "gcp",
      uploadedCount: uploaded,
      skippedUnchangedCount: skipped,
      location: `gs://${h.stagingBucketName}/${prefix}`,
    };
  },

  async promoteToProduction({ sourceRunId, fromTarget, toTarget, siteBaseUrl }) {
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
    const { buildRobotsTxtWithSitemap, envNoindexBuildError, manifestBakesEnvNoindex } =
      await import("@caelo-cms/static-generator");
    // routing-manifest.json changes every build (runId, builtAt), so the
    // hash-skip never leaves it out of the staging prefix.
    const stagingManifest = h.stagingBucket.file(`${prefix}routing-manifest.json`);
    const [stagingManifestExists] = await stagingManifest.exists();
    const stagingManifestBody = stagingManifestExists
      ? (await stagingManifest.download())[0].toString("utf8")
      : null;
    if (
      fromTarget.robotsDefault === "noindex" &&
      toTarget.robotsDefault === "index" &&
      manifestBakesEnvNoindex(parseJsonOrNull(stagingManifestBody))
    ) {
      throw envNoindexBuildError(sourceRunId);
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
      // Keep the Content-Type publishStaging stored on the staged
      // object: bare-slug pages ('no-extension' URL style) were
      // uploaded as text/html via the _content-types.json sidecar, and
      // re-deriving from the (missing) extension here would demote
      // them to application/octet-stream with the 1h asset policy.
      const stagedContentType = (stagedFile.metadata as { contentType?: unknown } | undefined)
        ?.contentType;
      const contentType =
        typeof stagedContentType === "string" ? stagedContentType : contentTypeFor(relPath);
      await stagedFile.copy(h.staticBucket.file(relPath), {
        contentType,
        metadata: { cacheControl: cacheControlForContentType(contentType, relPath) },
      });
      copied += 1;
    });
    // Apply per-target robots.txt + routing-manifest overrides. After
    // the copy loop the sitemap is live whether it changed (copied just
    // now) or was hash-skipped as unchanged. Staging's X-Robots-Tag
    // lives only on the staging-preview proxy response, never in object
    // metadata, so there is no header to strip here.
    const [sitemapLive] = await h.staticBucket.file("sitemap.xml").exists();
    const robotsBody = buildRobotsTxtWithSitemap(toTarget.robotsDefault, siteBaseUrl, sitemapLive);
    await uploadBytes(h.staticBucket, "robots.txt", Buffer.from(robotsBody, "utf8"), "text/plain");
    copied += 1;
    // Refresh the routing manifest if staging produced one.
    if (stagingManifestBody !== null) {
      try {
        const manifest = JSON.parse(stagingManifestBody) as Record<string, unknown>;
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
    // v0.2.85 — same content-type-override pattern as publishStaging
    // so a rollback restores bare-slug pages with the right
    // Content-Type.
    const contentTypeOverrides = await readContentTypeOverrides(sourceBuildDir);
    let uploaded = 0;
    await runBatched(files, PARALLEL_UPLOADS, async (file) => {
      const contentType =
        contentTypeOverrides[file.relativePath] ?? contentTypeFor(file.relativePath);
      await uploadFile(h.staticBucket, {
        key: file.relativePath,
        sitePath: file.relativePath,
        absolutePath: file.absolutePath,
        contentType,
      });
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

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readLiveManifest(staticBucket: Bucket): Promise<BuildManifest | null> {
  const file = staticBucket.file(MANIFEST_KEY);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [body] = await file.download();
  const manifest = JSON.parse(body.toString("utf8")) as BuildManifest;
  // Stale policy → treat as "nothing live" so every file is re-uploaded
  // with current Cache-Control metadata (see CACHE_POLICY_VERSION).
  if (manifest.cachePolicyVersion !== CACHE_POLICY_VERSION) return null;
  return manifest;
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
  return { buildId, files: entries, cachePolicyVersion: CACHE_POLICY_VERSION };
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

async function uploadFile(
  bucket: Bucket,
  args: {
    /** Object key in `bucket` (staging keys carry the `<runId>/` prefix). */
    key: string;
    /** Build-dir-relative path as the site serves it — drives the policy. */
    sitePath: string;
    absolutePath: string;
    contentType: string;
  },
): Promise<void> {
  await bucket.upload(args.absolutePath, {
    destination: args.key,
    contentType: args.contentType,
    // v0.2.85 — Cache-Control follows the content-type, not the key
    // extension, so bare-slug HTML pages get the same short
    // max-age + SWR as keyed `.html` files. The policy is keyed on the
    // site path, not the object key, so the staging `<runId>/` prefix
    // can't hide a content-hashed path.
    metadata: { cacheControl: cacheControlForContentType(args.contentType, args.sitePath) },
  });
}

async function readContentTypeOverrides(buildDir: string): Promise<Record<string, string>> {
  try {
    const body = await readFile(join(buildDir, "_content-types.json"), "utf8");
    return JSON.parse(body) as Record<string, string>;
  } catch {
    // Older generator runs without the sidecar — assume empty map +
    // fall back to extension-based content-type lookup.
    return {};
  }
}

function cacheControlForContentType(contentType: string, key: string): string {
  // Content-hashed outputs (fonts, plugin bundles, Vite chunks) are
  // immutable regardless of content-type — the hash in the path is the
  // signal. Slug-addressed media stays on the 1h default below.
  if (isContentHashedPath(key)) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  if (contentType.startsWith("text/html")) {
    return HTML_CACHE_CONTROL;
  }
  if (key === "routing-manifest.json" || key === "_content-types.json") {
    return "public, max-age=10";
  }
  if (contentType.startsWith("application/json")) {
    return "public, max-age=60";
  }
  if (key === "robots.txt" || key === "sitemap.xml") {
    return "public, max-age=300";
  }
  return "public, max-age=3600";
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
  if (isContentHashedPath(key)) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  if (key.endsWith(".html") || key === "index.html") {
    return HTML_CACHE_CONTROL;
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
