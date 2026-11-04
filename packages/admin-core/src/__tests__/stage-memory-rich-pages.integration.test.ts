// SPDX-License-Identifier: MPL-2.0

/**
 * Stage memory on real-sized pages (searchVIU incident, 2026-11-01).
 *
 * The searchVIU admin (2 GiB) was OOM-killed staging 162 English pages of
 * ~280 KB: the generator subprocess grew by ~5 MB per page while it
 * composed, to 1.3 GB, next to an admin that itself sat near 1 GB. Two
 * causes, both pinned here:
 *
 *   1. The template engine's Mustache parse cache. Mustache keeps the
 *      parsed tokens of every template it ever rendered, keyed by the
 *      template text, and the engine hands it a different text on every
 *      call (sentinels carry a per-call UUID; list entries, nested modules
 *      and link references are pasted in before Mustache runs). So every
 *      module of every page stayed in the process for good: in the
 *      generator, and in the admin, which renders pages all day (Live Edit,
 *      inspect_page_render, screenshots).
 *   2. A batch of 200 large pages: composing and rewriting a page allocates
 *      many times its HTML in short-lived copies, collected late, so the
 *      peak followed the HTML composed per batch. The generator now writes
 *      a batch in chunks of a fixed amount of HTML (CHUNK_HTML_CHARS).
 *
 * The #1271 scale tests did not see either: their pages are a few KB and
 * render one identical module text on every page — a cache hit each time.
 * This fixture renders what real pages render (fixtures/rich-site.ts) and
 * stages it through the real generator subprocess and the Firebase
 * publisher (in-memory Hosting).
 */

import { heapStats } from "bun:jsc";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PhaseTiming } from "@caelo-cms/shared";
import { PAGE_BATCH } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import * as realGoogleAuth from "google-auth-library";
import { setStagingBucketForTests } from "../deploy/staging-slots.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { FakeFirebaseHosting } from "./fixtures/fake-firebase-hosting.js";
import { fakeStagingBucket } from "./fixtures/fake-staging-bucket.js";
import {
  RICH_PREFIX,
  type RichSite,
  seedRichPagesTo,
  seedRichSite,
  wipeRichSite,
} from "./fixtures/rich-site.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const realGoogleAuthExports = { ...realGoogleAuth };
mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "rich-memory-token" }) };
    }
  },
}));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SITE = "rich-memory-site";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "stage-memory-rich-pages-test",
};
/**
 * Page counts staged, ascending (override: RICH_PAGES=162,600). Both
 * defaults are above PAGE_BATCH: the generator loads a whole batch's
 * compose inputs at once, so a size below it measures how full the first
 * batch is (60 -> 300 pages grew ~100 MB in load-batch alone), not whether
 * the peak grows with the site.
 */
const SIZES = (process.env.RICH_PAGES ?? `${PAGE_BATCH + 20},${2 * PAGE_BATCH + 40}`)
  .split(",")
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => n > 0)
  .sort((a, b) => a - b);
/**
 * How much the generator's peak may grow from the smallest to the largest
 * size. What may grow with the site is a small record per page plus the
 * collector's slack. Before the fix it grew by ~3 MB per page of this
 * fixture (60 → 162 pages: 337 → 823 MB); after it, 60 → 400 pages:
 * 348 → 375 MB.
 */
const MAX_GROWTH_MB = 100;
/**
 * Live heap the admin may keep after previewing every page of the largest
 * size. Before the fix: 825 MB after 200 previews; keeping even just the
 * pages' HTML would be > 50 MB at 300 pages.
 */
const MAX_PREVIEW_RETAINED_MB = 24;

const realFetch = globalThis.fetch;
const hosting = new FakeFirebaseHosting(SITE, realFetch);
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let root: string;
let site: RichSite;
const restore: (() => Promise<void>)[] = [];

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
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

interface StageResult {
  pages: number;
  generatorPeakMb: number;
  phases: string;
}

async function stage(pages: number): Promise<StageResult> {
  const staged = await ok<{ runId: string; phases: PhaseTiming[] }>("deploy.trigger", {
    targetName: "staging",
    repoRoot: root,
  });
  const peak = Math.max(
    0,
    ...staged.phases.filter((p) => p.phase.startsWith("generator.")).map((p) => p.peakRssMb ?? 0),
  );
  return {
    pages,
    generatorPeakMb: peak,
    phases: staged.phases.map((p) => `${p.phase}:${p.ms}ms/${p.peakRssMb ?? "-"}MB`).join(" "),
  };
}

/** This process's live heap (JS objects + the strings outside it) after a full collection. */
function liveHeapMb(): number {
  Bun.gc(true);
  const h = heapStats();
  return (h.heapSize + h.extraMemorySize) / 1048576;
}

beforeAll(async () => {
  Object.assign(process.env, {
    CAELO_PROVIDER: "gcp-firebase",
    CAELO_STAGING_GATE_SECRET: "rich-memory-gate-secret",
    CAELO_FIREBASE_SITE: SITE,
    CAELO_GATEWAY_SERVICE: "gateway",
    CAELO_GATEWAY_REGION: "europe-west1",
    CAELO_SKIP_STAGING_SERVE_CHECK: "1",
  });
  globalThis.fetch = hosting.fetch as typeof fetch;
  // #1330 — a Stage mirrors its build into the private staging bucket; the
  // fake keeps no page bytes, so it adds nothing to the measured heap.
  setStagingBucketForTests(fakeStagingBucket({ keepBodies: false }).bucket);
  restore.push(async () => setStagingBucketForTests(null));
  restore.push(await pinSiteBaseUrl(ADMIN_URL!, "https://example.com"));
  restore.push(await pinSiteLanguage(ADMIN_URL!, "en"));
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await system(wipeRichSite);
  root = await mkdtemp(join(tmpdir(), "caelo-rich-memory-"));
  process.env.MEDIA_ROOT_DIR = join(root, "media");
  await ok("staging_access.seed_host", { host: "staging.example.com" });
  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${RICH_PREFIX}-tpl`,
    displayName: "Rich",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "body{margin:0}",
  });
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  site = await system((tx) => seedRichSite(tx, templateId));
  await ok("pages.set_home_page", { pageId: site.homeId });
}, 300_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  mock.module("google-auth-library", () => realGoogleAuthExports);
  for (const undo of restore.reverse()) await undo();
  await system(wipeRichSite);
  await system(async (tx) => {
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${RICH_PREFIX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${RICH_PREFIX}-tpl`}`;
  });
  await rm(root, { recursive: true, force: true });
  await adapter.close();
});

describe("Stage memory on real-sized pages", () => {
  it("a fixture page weighs what a real marketing page does", async () => {
    const home = await ok<{ html: string; missingSlots: string[] }>("pages.render_preview", {
      pageId: site.homeId,
    });
    console.info(`[rich-memory] a page composes to ${Math.round(home.html.length / 1024)} KB`);
    expect(home.missingSlots).toEqual([]);
    expect(home.html.length).toBeGreaterThan(150_000);
  });

  it(
    "the generator's peak does not grow with the number of pages",
    async () => {
      const results: StageResult[] = [];
      for (const n of SIZES) {
        await system((tx) => seedRichPagesTo(tx, site, n));
        const r = await stage(n);
        console.info(`[rich-memory] ${n} pages: ${JSON.stringify(r)}`);
        results.push(r);
      }
      const small = results[0] as StageResult;
      const large = results[results.length - 1] as StageResult;
      expect(large.generatorPeakMb - small.generatorPeakMb).toBeLessThan(MAX_GROWTH_MB);
    },
    { timeout: 900_000 },
  );

  it("rendering every page in the admin keeps nothing of them", async () => {
    const ids = (await system(
      (tx) => tx`SELECT id::text AS id FROM pages WHERE slug LIKE ${`${RICH_PREFIX}-%`}`,
    )) as { id: string }[];
    expect(ids.length).toBe(SIZES[SIZES.length - 1] as number);
    const before = liveHeapMb();
    for (const { id } of ids) await ok("pages.render_preview", { pageId: id });
    const retained = liveHeapMb() - before;
    console.info(`[rich-memory] ${ids.length} previews retained ${retained.toFixed(1)} MB`);
    expect(retained).toBeLessThan(MAX_PREVIEW_RETAINED_MB);
  }, 300_000);
});
