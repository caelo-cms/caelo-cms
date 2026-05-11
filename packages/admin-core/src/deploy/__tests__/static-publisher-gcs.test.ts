// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — unit-tests for the GCS static publisher.
 *
 * Mocks @google-cloud/storage's Storage / Bucket / File so we can
 * assert the publisher's behaviour against a tmp build dir without
 * touching real GCS:
 *   - publishStaging walks buildDir, uploads to staging bucket under
 *     <runId>/ prefix, with right Cache-Control + Content-Type
 *   - hash-skip: when a file's CRC32C matches the live manifest, no
 *     upload (proves the rsync-over-GCS optimisation works)
 *   - promoteToProduction copies _staging/<runId>/* → static bucket
 *     root via server-side .copy()
 *   - per-target robots.txt + routing-manifest patches applied
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployTarget } from "@caelo-cms/static-generator";

interface MockFile {
  name: string;
  body?: Buffer;
  metadata?: Record<string, unknown>;
  exists: () => Promise<[boolean]>;
  download: () => Promise<[Buffer]>;
  getMetadata: () => Promise<[Record<string, unknown>]>;
  save: ReturnType<typeof mock>;
  copy: ReturnType<typeof mock>;
}

interface MockBucket {
  name: string;
  files: Map<string, MockFile>;
  file: (key: string) => MockFile;
  upload: ReturnType<typeof mock>;
  getFiles: (opts?: { prefix?: string }) => Promise<[MockFile[]]>;
}

function makeFile(bucket: MockBucket, key: string): MockFile {
  const f: MockFile = {
    name: key,
    exists: () => Promise.resolve([bucket.files.has(key)]),
    download: () => {
      const cached = bucket.files.get(key);
      if (!cached?.body) throw new Error(`no body for ${key}`);
      return Promise.resolve([cached.body]);
    },
    getMetadata: () => Promise.resolve([bucket.files.get(key)?.metadata ?? {}]),
    save: mock(
      async (
        body: Buffer | string,
        opts?: { contentType?: string; metadata?: { cacheControl?: string } },
      ) => {
        bucket.files.set(key, {
          ...f,
          body: typeof body === "string" ? Buffer.from(body) : body,
          metadata: { contentType: opts?.contentType, ...opts?.metadata },
        });
      },
    ),
    copy: mock(
      async (
        dest: MockFile,
        opts?: { contentType?: string; metadata?: { cacheControl?: string } },
      ) => {
        const src = bucket.files.get(key);
        if (!src?.body) throw new Error(`no source body for copy from ${key}`);
        // Find which bucket dest belongs to via the captured closure.
        // For simplicity here both buckets share the registry below;
        // dest.name is the key in dest's bucket.
        // The test fixture wires this correctly.
        destBucketRegistry.get(dest)?.files.set(dest.name, {
          ...dest,
          body: src.body,
          metadata: { contentType: opts?.contentType, ...opts?.metadata },
        });
      },
    ),
  };
  return f;
}

const destBucketRegistry = new WeakMap<MockFile, MockBucket>();

function makeBucket(name: string): MockBucket {
  const bucket: MockBucket = {
    name,
    files: new Map(),
    file: (key: string) => {
      const cached = bucket.files.get(key);
      if (cached) return cached;
      const f = makeFile(bucket, key);
      destBucketRegistry.set(f, bucket);
      return f;
    },
    upload: mock(
      async (
        absolutePath: string,
        opts: { destination: string; contentType?: string; metadata?: { cacheControl?: string } },
      ) => {
        const body = await Bun.file(absolutePath).bytes();
        bucket.files.set(opts.destination, {
          ...makeFile(bucket, opts.destination),
          body: Buffer.from(body),
          metadata: { contentType: opts.contentType, ...opts.metadata },
        });
      },
    ),
    getFiles: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const result: MockFile[] = [];
      for (const [key, f] of bucket.files.entries()) {
        if (key.startsWith(prefix)) result.push(f);
      }
      return [result];
    },
  };
  return bucket;
}

let staticBucket: MockBucket;
let stagingBucket: MockBucket;

mock.module("@google-cloud/storage", () => ({
  Storage: class {
    bucket(name: string): MockBucket {
      if (name === "test-static") return staticBucket;
      if (name === "test-staging") return stagingBucket;
      throw new Error(`unknown bucket ${name}`);
    }
  },
}));

mock.module("@caelo-cms/static-generator", () => ({
  buildRobotsTxt: (mode: "index" | "noindex") =>
    mode === "noindex" ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n",
}));

let buildDir: string;

beforeEach(async () => {
  staticBucket = makeBucket("test-static");
  stagingBucket = makeBucket("test-staging");
  process.env.CAELO_STATIC_BUCKET = "test-static";
  process.env.CAELO_STAGING_BUCKET = "test-staging";
  buildDir = await mkdtemp(join(tmpdir(), "caelo-pub-"));
  await mkdir(join(buildDir, "en", "about"), { recursive: true });
  await writeFile(join(buildDir, "en", "about", "index.html"), "<html>about</html>", "utf8");
  await writeFile(join(buildDir, "robots.txt"), "default robots", "utf8");
  await mkdir(join(buildDir, "_app", "immutable", "chunks"), { recursive: true });
  await writeFile(
    join(buildDir, "_app", "immutable", "chunks", "abc.js"),
    "console.log(1)",
    "utf8",
  );
});

afterEach(async () => {
  await rm(buildDir, { recursive: true, force: true });
  delete process.env.CAELO_STATIC_BUCKET;
  delete process.env.CAELO_STAGING_BUCKET;
});

const TARGET: DeployTarget = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "staging",
  env: "staging",
  outDir: "/tmp/caelo-builds/staging",
  baseUrl: "https://example.com",
  robotsDefault: "noindex",
  isDefault: false,
};

const PROD_TARGET: DeployTarget = {
  ...TARGET,
  name: "production",
  env: "production",
  robotsDefault: "index",
  isDefault: true,
};

describe("gcsStaticPublisher.publishStaging", () => {
  it("uploads every file when no live manifest exists", async () => {
    const { gcsStaticPublisher } = await import("../static-publisher-gcs.js");
    const summary = await gcsStaticPublisher.publishStaging({
      buildDir,
      runId: "run-1",
      target: TARGET,
    });
    expect(summary.provider).toBe("gcp");
    expect(summary.uploadedCount).toBe(3);
    expect(summary.skippedUnchangedCount).toBe(0);
    expect(summary.location).toBe("gs://test-staging/run-1/");
    // Files landed under the runId prefix in the staging bucket.
    expect(stagingBucket.files.has("run-1/en/about/index.html")).toBe(true);
    expect(stagingBucket.files.has("run-1/_app/immutable/chunks/abc.js")).toBe(true);
    expect(stagingBucket.files.has("run-1/robots.txt")).toBe(true);
    // Cache-Control headers picked per file type.
    const html = stagingBucket.files.get("run-1/en/about/index.html");
    expect((html?.metadata as { cacheControl?: string })?.cacheControl).toContain(
      "stale-while-revalidate",
    );
    const js = stagingBucket.files.get("run-1/_app/immutable/chunks/abc.js");
    expect((js?.metadata as { cacheControl?: string })?.cacheControl).toContain("immutable");
  });

  it("v0.2.85 — honours _content-types.json sidecar for bare-slug uploads", async () => {
    // Simulate a no-extension build: replace `en/about/index.html` with a
    // bare-slug `en/about` (no extension) + emit the sidecar declaring
    // the override. Publisher should upload `en/about` with
    // Content-Type: text/html and Cache-Control matching HTML.
    await rm(buildDir, { recursive: true, force: true });
    buildDir = await mkdtemp(join(tmpdir(), "caelo-pub-noext-"));
    await mkdir(join(buildDir, "en"), { recursive: true });
    await writeFile(join(buildDir, "en", "about"), "<html>about</html>", "utf8");
    await writeFile(
      join(buildDir, "_content-types.json"),
      JSON.stringify({ "en/about": "text/html; charset=utf-8" }),
      "utf8",
    );
    const { gcsStaticPublisher } = await import("../static-publisher-gcs.js");
    await gcsStaticPublisher.publishStaging({
      buildDir,
      runId: "run-noext",
      target: TARGET,
    });
    const file = stagingBucket.files.get("run-noext/en/about");
    expect(file).toBeDefined();
    const meta = file?.metadata as { contentType?: string; cacheControl?: string };
    expect(meta.contentType).toContain("text/html");
    expect(meta.cacheControl).toContain("stale-while-revalidate");
  });

  it("skips uploads when CRC32C matches the live manifest", async () => {
    // Pre-seed the live manifest with the CRC of the about page.
    const aboutBody = "<html>about</html>";
    const knownCrc = computeCrc32cBase64(Buffer.from(aboutBody, "utf8"));
    staticBucket.files.set("_state/last-build-manifest.json", {
      ...makeFile(staticBucket, "_state/last-build-manifest.json"),
      body: Buffer.from(
        JSON.stringify({ buildId: "prev", files: { "en/about/index.html": knownCrc } }),
      ),
    });
    const { gcsStaticPublisher } = await import("../static-publisher-gcs.js");
    const summary = await gcsStaticPublisher.publishStaging({
      buildDir,
      runId: "run-2",
      target: TARGET,
    });
    expect(summary.skippedUnchangedCount).toBe(1);
    expect(summary.uploadedCount).toBe(2);
    expect(stagingBucket.files.has("run-2/en/about/index.html")).toBe(false);
  });
});

describe("gcsStaticPublisher.promoteToProduction", () => {
  it("copies staging objects to static bucket root and patches robots.txt", async () => {
    // First publish to populate staging.
    const { gcsStaticPublisher } = await import("../static-publisher-gcs.js");
    await gcsStaticPublisher.publishStaging({
      buildDir,
      runId: "run-3",
      target: TARGET,
    });
    expect(stagingBucket.files.size).toBeGreaterThan(0);

    const summary = await gcsStaticPublisher.promoteToProduction({
      sourceRunId: "run-3",
      sourceBuildDir: buildDir,
      fromTarget: TARGET,
      toTarget: PROD_TARGET,
    });
    expect(summary.provider).toBe("gcp");
    expect(summary.location).toBe("gs://test-static/");
    // Static bucket has the about page at root (no runId prefix).
    expect(staticBucket.files.has("en/about/index.html")).toBe(true);
    // robots.txt was patched with the destination's robotsDefault.
    const robots = staticBucket.files.get("robots.txt");
    expect(robots?.body?.toString("utf8")).toContain("Allow: /");
  });
});

// Reused from static-publisher-gcs.ts (kept in sync; tested above by
// the manifest-skip case which exercises the full code path).
function computeCrc32cBase64(buf: Buffer): string {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[i] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ (table[(c ^ buf[i]!) & 0xff] ?? 0);
  }
  c = (c ^ 0xffffffff) >>> 0;
  const bytes = new Uint8Array(4);
  bytes[0] = (c >>> 24) & 0xff;
  bytes[1] = (c >>> 16) & 0xff;
  bytes[2] = (c >>> 8) & 0xff;
  bytes[3] = c & 0xff;
  return Buffer.from(bytes).toString("base64");
}
