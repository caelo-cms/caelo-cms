// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — Stage memory does not grow with the site.
 *
 * On 2026-10-30 a 2 GiB admin was OOM-killed staging 122 pages: the build
 * held every page, copied every image into the build (memory on Cloud Run)
 * and the Firebase publisher gzipped every file into the heap at once. This
 * test stages the same site at 1,000 and at 10,000 pages, every page with
 * images, through the real generator subprocess and the Firebase Hosting
 * publisher (in-memory Hosting, no network), and asserts:
 *
 *   - the generator's peak resident memory stays flat (it holds a page
 *     batch and a small record per page, never every page);
 *   - the admin side's peak during the upload stays flat (bounded hashing,
 *     uploads streamed, media referenced by stored digest);
 *   - not one media file goes through the build: after the first Stage
 *     uploaded the media, a Stage of ten times the pages uploads no media.
 *
 * Pages are bulk-inserted with SQL (clones of one page built through the
 * ops), so the 10k fixture takes seconds, not minutes.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PhaseTiming } from "@caelo-cms/shared";
import { SQL } from "bun";
import * as realGoogleAuth from "google-auth-library";
import sharp from "sharp";
import { runMediaPipeline } from "../media/pipeline.js";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { FakeFirebaseHosting } from "./fixtures/fake-firebase-hosting.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const realGoogleAuthExports = { ...realGoogleAuth };
mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "memory-test-token" }) };
    }
  },
}));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SITE = "memory-site";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "build-memory-test",
};
const MEDIA = 24;
const SIZES = [1_000, 10_000] as const;
/**
 * How much the peak may grow from 1k to 10k pages. What legitimately grows
 * is a small record per page (path, SEO row, URL, parity digest — a few KB
 * each, ~30 MB at 10k) plus the garbage collector's slack; what grew before
 * #1271 was the site itself (generator 385 → 886 MB, admin 1,471 →
 * 3,461 MB on the same fixture shape).
 */
const MAX_GROWTH_MB = 128;

const realFetch = globalThis.fetch;
const hosting = new FakeFirebaseHosting(SITE, realFetch);
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let root: string;
let templateId = "";
let heroId = "";
let headerId = "";
let headerContent = "";
const mediaSlugs: string[] = [];
const restore: (() => Promise<void>)[] = [];
let seeded = 0;

async function ok<T>(op: string, input: unknown, ctx = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function system<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
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

/** This fixture's rows (templates survive the per-file reset: seed data). */
async function wipe(): Promise<void> {
  await system(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug = 'memory-tpl'))`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug = 'memory-tpl'))`;
    await tx`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug = 'memory-tpl')`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE 'memory-%')`;
    await tx`DELETE FROM modules WHERE slug LIKE 'memory-%'`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = 'memory-tpl')`;
    await tx`DELETE FROM templates WHERE slug = 'memory-tpl'`;
    await tx`DELETE FROM media_assets WHERE slug LIKE 'memory-photo-%'`;
  });
}

/** A small photo-like PNG: smoothed noise, so its variants are real files. */
async function photo(seed: number): Promise<Uint8Array> {
  const w = 60;
  const h = 40;
  const raw = Buffer.alloc(w * h * 3);
  let x = seed * 2654435761;
  for (let k = 0; k < raw.length; k += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    raw[k] = x >>> 24;
  }
  return new Uint8Array(
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .resize(900, 600)
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

/** Clone the seed page `n` times (pages, SEO rows, content, placements). */
async function seedTo(n: number): Promise<void> {
  const from = seeded + 1;
  if (n < from) return;
  const slugs = JSON.stringify(mediaSlugs);
  await system(async (tx) => {
    await tx`
      INSERT INTO pages (slug, title, template_id, status)
      SELECT 'mem-' || g, 'Memory page ' || g, ${templateId}::uuid, 'published'
      FROM generate_series(${from}::int, ${n}::int) g`;
    await tx`
      INSERT INTO pages_seo (page_id, meta_description)
      SELECT p.id, 'A page of the build-memory fixture.' FROM pages p
      WHERE p.slug LIKE 'mem-%' AND NOT EXISTS (SELECT 1 FROM pages_seo s WHERE s.page_id = p.id)`;
    await tx`
      INSERT INTO content_instances (module_id, slug, values)
      SELECT ${heroId}::uuid, 'mem-hero-' || g,
             jsonb_build_object(
               'hero_title', 'Memory page ' || g,
               'hero_image', '/_caelo/media/' || ((${slugs}::text)::jsonb ->> (g % ${MEDIA})),
               'inline_image', '/_caelo/media/' || ((${slugs}::text)::jsonb ->> ((g + 7) % ${MEDIA})),
               'body', repeat('Copy of page ' || g || ' about crawling, rendering and indexing. ', 40))
      FROM generate_series(${from}::int, ${n}::int) g`;
    await tx`
      INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
      SELECT p.id, 'content', 0, ${headerId}::uuid, ${headerContent}::uuid, 'synced'
      FROM pages p
      WHERE p.slug LIKE 'mem-%' AND NOT EXISTS (SELECT 1 FROM page_modules pm WHERE pm.page_id = p.id)`;
    await tx`
      INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
      SELECT p.id, 'content', 1, ${heroId}::uuid, ci.id, 'unsynced'
      FROM pages p JOIN content_instances ci ON ci.slug = 'mem-hero-' || substr(p.slug, 5)
      WHERE p.slug LIKE 'mem-%'
        AND NOT EXISTS (SELECT 1 FROM page_modules pm WHERE pm.page_id = p.id AND pm.position = 1)`;
  });
  seeded = n;
}

/** The stored gzip hash of every media file (what Hosting knows them by). */
async function mediaHashes(): Promise<string[]> {
  const rows = (await system((tx) => tx`SELECT gzip_sha256 FROM media_variants`)) as {
    gzip_sha256: string;
  }[];
  return rows.map((r) => r.gzip_sha256);
}

interface StageResult {
  generatorPeakMb: number;
  uploadPeakMb: number;
  /** The admin's resident memory as the Stage started. */
  startMb: number;
  /** Media files (by gzip hash) this Stage uploaded. */
  mediaUploaded: number;
  /**
   * The most bytes the build ever had on the admin's disk. On Cloud Run that
   * disk is memory (tmpfs), so it counts like RSS (#1271: only the build's
   * description may be there; the files stream to the provider).
   */
  localPeakBytes: number;
  /** Bytes the build uploaded to Hosting (its pages, bundles, manifests). */
  uploadedPages: number;
}

/** The largest total size the build directories under `dir` reached while `run` ran. */
async function peakDiskBytes<T>(dir: string, run: () => Promise<T>): Promise<[T, number]> {
  let peak = 0;
  let running = true;
  const size = async (d: string): Promise<number> => {
    let total = 0;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const path = join(d, e.name);
      if (e.isDirectory()) total += await size(path);
      else total += (await stat(path).catch(() => ({ size: 0 }))).size;
    }
    return total;
  };
  const loop = (async () => {
    while (running) {
      peak = Math.max(peak, await size(dir));
      await Bun.sleep(100);
    }
  })();
  try {
    const out = await run();
    return [out, peak];
  } finally {
    running = false;
    await loop;
    peak = Math.max(peak, await size(dir));
  }
}

async function stage(): Promise<StageResult> {
  const before = hosting.uploaded.length;
  const pagesBefore = hosting.uploadedBytes;
  const [staged, localPeakBytes] = await peakDiskBytes(join(root, "output"), () =>
    ok<{ runId: string; phases: PhaseTiming[] }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: root,
    }),
  );
  console.info(
    "[build-memory] phases",
    staged.phases
      .map((p) => `${p.phase}:${p.ms}ms/${p.cpuMs ?? "-"}cpu/${p.peakRssMb ?? "-"}MB`)
      .join(" "),
  );
  const peak = (prefix: string) =>
    Math.max(
      0,
      ...staged.phases.filter((p) => p.phase.startsWith(prefix)).map((p) => p.peakRssMb ?? 0),
    );
  return {
    generatorPeakMb: peak("generator."),
    uploadPeakMb: peak("publish."),
    startMb: staged.phases.find((p) => p.phase === "prepare")?.peakRssMb ?? 0,
    mediaUploaded: (await mediaHashes()).filter((h) => hosting.uploaded.slice(before).includes(h))
      .length,
    localPeakBytes,
    uploadedPages: hosting.uploadedBytes - pagesBefore,
  };
}

beforeAll(async () => {
  Object.assign(process.env, {
    CAELO_PROVIDER: "gcp-firebase",
    CAELO_STAGING_GATE_SECRET: "memory-gate-secret",
    CAELO_FIREBASE_SITE: SITE,
    CAELO_GATEWAY_SERVICE: "gateway",
    CAELO_GATEWAY_REGION: "europe-west1",
    CAELO_SKIP_STAGING_SERVE_CHECK: "1",
  });
  globalThis.fetch = hosting.fetch as typeof fetch;
  restore.push(await pinSiteBaseUrl(ADMIN_URL!, "https://example.com"));
  restore.push(await pinSiteLanguage(ADMIN_URL!, "en"));
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  root = await mkdtemp(join(tmpdir(), "caelo-build-memory-"));
  process.env.MEDIA_ROOT_DIR = join(root, "media");
  const storage = new LocalVolumeAdapter(join(root, "media"));
  setMediaStorage(storage);
  await ok("staging_access.seed_host", { host: "staging.example.com" });

  for (let i = 0; i < MEDIA; i += 1) {
    const body = await photo(i + 1);
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const result = await runMediaPipeline(sha, "image/jpeg", body);
    for (const v of result.variants) await storage.put(v.storageKey, v.body, v.contentType);
    const up = await ok<{ slug: string }>("media.upload", {
      sha256: sha,
      originalName: `memory-${i}.jpg`,
      name: `memory-photo-${i}`,
      mime: "image/jpeg",
      sizeBytes: body.byteLength,
      width: result.width,
      height: result.height,
      alt: `Memory photo ${i}`,
      storageKey: result.variants[0]?.storageKey ?? `${sha}/orig`,
      variants: result.variants.map((v) => ({
        variant: v.variant,
        format: v.format,
        width: v.width,
        height: v.height,
        sizeBytes: v.sizeBytes,
        storageKey: v.storageKey,
        digest: v.digest,
      })),
    });
    mediaSlugs.push(up.slug);
  }

  templateId = (
    await ok<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: "memory-tpl",
      displayName: "Memory",
      html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "body{margin:0}",
    })
  ).templateId;
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const mod = async (slug: string, html: string, fields: string[]) =>
    (
      await ok<{ moduleId: string }>("modules.create", {
        slug,
        displayName: slug,
        html,
        css: `.${slug}{padding:1rem}`,
        fields: fields.map((name) => ({ name, kind: "text", label: name })),
      })
    ).moduleId;
  headerId = await mod("memory-header", `<header class="memory-header">{{brand}}</header>`, [
    "brand",
  ]);
  heroId = await mod(
    "memory-hero",
    `<section class="memory-hero"><img src="{{hero_image}}" alt="{{hero_title}}"><h1>{{hero_title}}</h1><p>{{body}}</p><img src="{{inline_image}}" alt="inline"></section>`,
    ["hero_title", "hero_image", "inline_image", "body"],
  );
  headerContent = (
    await ok<{ contentInstanceId: string }>("content_instances.create", {
      moduleId: headerId,
      slug: "memory-header-content",
      displayName: "Memory header",
      purpose: "Site-wide chrome of the build-memory fixture.",
      values: { brand: "Memory" },
    })
  ).contentInstanceId;
  // The home page, through the ops; every other page is its SQL clone.
  const { pageId } = await ok<{ pageId: string }>("pages.build_page", {
    page: { slug: "home", title: "Home", templateId },
    modules: [
      {
        blockName: "content",
        moduleId: headerId,
        content: { source: "existing", contentInstanceId: headerContent },
      },
    ],
  });
  await ok("pages.update", { pageId, status: "published" });
  await ok("pages_seo.autofill", { pageId, metaDescription: "Home of the build-memory fixture." });
}, 300_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  mock.module("google-auth-library", () => realGoogleAuthExports);
  for (const undo of restore.reverse()) await undo();
  await wipe();
  await rm(root, { recursive: true, force: true });
  await adapter.close();
});

describe("#1271 Stage memory is flat in the site's size", () => {
  it(
    "1k vs 10k pages with media: flat peak RSS, and no media byte in a Stage that needs none",
    async () => {
      const results = new Map<number, StageResult>();
      for (const n of SIZES) {
        await seedTo(n);
        results.set(n, await stage());
      }
      const small = results.get(SIZES[0]) as StageResult;
      const large = results.get(SIZES[1]) as StageResult;
      console.info("[build-memory]", JSON.stringify(Object.fromEntries(results)));

      // The first Stage put the media on Hosting; ten times the pages
      // reference the same files, so not one is sent again.
      expect(small.mediaUploaded).toBe((await mediaHashes()).length);
      expect(large.mediaUploaded).toBe(0);

      expect(large.generatorPeakMb - small.generatorPeakMb).toBeLessThan(MAX_GROWTH_MB);
      // tmpfs: the HTML went to Hosting as it was written; what stayed on
      // disk is the build's description (asset references, parity digests,
      // render deps) — a small fraction of what was uploaded.
      // Every page carries ~2.8 KB of copy, so 10k pages are ≥ 28 MB of HTML;
      // the description is a few hundred bytes per page.
      expect(large.uploadedPages).toBeGreaterThan(0);
      expect(large.localPeakBytes).toBeLessThan(SIZES[1] * 1024);
      // The admin process is this test runner; compare what the upload
      // added to where the Stage started.
      expect(
        large.uploadPeakMb - large.startMb - (small.uploadPeakMb - small.startMb),
      ).toBeLessThan(MAX_GROWTH_MB);
    },
    { timeout: 900_000 },
  );
});
