// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #803 (epic #1209) — font work per preview against a real Postgres:
 *
 * - a preview reads each bound face's bytes once (cold process cache) or
 *   not at all (warm), never once per typography role;
 * - the site's texts are read whole once per process; a change to them is
 *   carried forward by re-reading only the rows it names (#1270), and the
 *   cached result always equals what an uncached read under the reader's
 *   snapshot gives (maintained == rebuilt) — including writes made later in
 *   the scanning transaction, rolled-back writes, a write that commits
 *   after another transaction cached, and a reader older than the cache;
 * - preview and build keep producing identical font output.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearFontReaderCache,
  fontByteReadCount,
  fontMetadata,
  fontReader,
  fontReaderCachedBytes,
} from "@caelo-cms/font-service";
import {
  collectJournalGarbage,
  DatabaseAdapter,
  execute,
  OperationRegistry,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import type { ExecutionContext, SiteFontUsage, ThemeDocument } from "@caelo-cms/shared";
import {
  clearSiteFontUsageCache,
  loadSiteFontUsage,
  resolveThemeFonts,
  siteFontUsageReads,
} from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

const adapterOptions = {
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL!,
  publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
};
const adapter = new DatabaseAdapter(adapterOptions);
/** A second pool, so a test can hold one transaction open while another runs. */
const otherAdapter = new DatabaseAdapter(adapterOptions);
const registry = new OperationRegistry();
registerAdminOps(registry);
const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "font-reads-test",
};
const TAG = `font-reads-${crypto.randomUUID().slice(0, 8)}`;
const THEME_SLUG = `${TAG}-theme`;
const MODULE_SLUG = `${TAG}-caption`;
const FIXTURES = new URL("../../../font-service/src/fixtures/", import.meta.url);
const interBase64 = readFileSync(
  new URL("InterVariable-mini.woff2.base64.txt", FIXTURES),
  "utf8",
).trim();
const license = {
  name: "OFL-1.1",
  text: readFileSync(new URL("Inter-OFL.txt", FIXTURES), "utf8"),
  webEmbedding: true,
  documentEmbedding: true,
};

async function run(name: string, input: unknown) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

let tokens: ThemeDocument;
let ref: { id: string; sha256: string };
let pageId: string;
let cacheDir: string;
/** Below the git-ignored `data/fonts/`, apart from what the default cache holds. */
const PREVIEW_CACHE = `data/fonts/${TAG}`;

/** The scan an uncached loader gives under `tx`'s snapshot. */
async function uncached(tx: TransactionRunner): Promise<SiteFontUsage> {
  clearSiteFontUsageCache();
  return loadSiteFontUsage(tx, tokens);
}

/** Whole reads of the site's texts this process ran so far. */
function wholeReads(): number {
  return siteFontUsageReads().whole;
}

/** Rows re-read by deltas so far. */
function deltaRows(): number {
  return siteFontUsageReads().deltaRows;
}

/**
 * Load through the cache and assert it equals the uncached scan. Returns
 * the number of whole reads the cached load ran; the comparison itself
 * leaves a fresh entry from `tx` in the cache.
 */
async function loadAndCompare(tx: TransactionRunner): Promise<number> {
  const before = wholeReads();
  const usage = await loadSiteFontUsage(tx, tokens);
  const misses = wholeReads() - before;
  const truth = await uncached(tx);
  expect(usage).toEqual(truth);
  return misses;
}

async function setCaptionCss(tx: TransactionRunner, css: string): Promise<void> {
  await tx.execute(sql`UPDATE modules SET css = ${css} WHERE slug = ${MODULE_SLUG}`);
}

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "font-reads-test-"));
  // The preview op derives slices under CAELO_FONTS_CACHE_DIR (relative to
  // the cwd); a test-owned directory keeps this file from leaving slices in
  // the shared default cache, where other font tests would find them.
  process.env.CAELO_FONTS_CACHE_DIR = PREVIEW_CACHE;
  const font = fontMetadata.parse(
    await run("fonts.import", { dataBase64: interBase64, license, source: "test:inter-mini" }),
  );
  ref = { id: font.id, sha256: font.sha256 };
  await run("themes.duplicate", {
    sourceSlug: "site-default",
    newSlug: THEME_SLUG,
    newDisplayName: "Font reads test",
  });
  // Three roles, one face: the preview must read it once, not three times.
  await run("themes.update_tokens", {
    themeSlug: THEME_SLUG,
    fontBindings: { body: ref, heading: ref, display: ref },
  });
  tokens = ((await run("themes.get", { slug: THEME_SLUG })) as { theme: { tokens: ThemeDocument } })
    .theme.tokens;
  await run("modules.create", {
    slug: MODULE_SLUG,
    displayName: "Caption",
    html: '<p class="cap">x</p>',
    css: ".cap{font-weight:400}",
  });
  const template = (await run("templates.create", {
    pageType: "home",
    slug: `${TAG}-tpl`,
    displayName: `${TAG} template`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  })) as { templateId: string };
  await run("template_blocks.set", {
    templateId: template.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const built = (await run("pages.build_page", {
    page: { slug: TAG, title: "Fonts", templateId: template.templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${TAG} body`,
        description: "Page body text.",
        kind: "content",
        html: '<p class="body">{{body_text}}</p>',
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: "Hello" } },
      },
    ],
  })) as { pageId: string };
  pageId = built.pageId;
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await tx.execute(sql`UPDATE themes SET is_active=false WHERE is_active=true`);
    await tx.execute(sql`UPDATE themes SET is_active=true WHERE slug=${THEME_SLUG}`);
  });
});

beforeEach(() => {
  clearSiteFontUsageCache();
  clearFontReaderCache();
});

afterAll(async () => {
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await tx.execute(sql`UPDATE themes SET is_active=false WHERE is_active=true`);
    await tx.execute(sql`UPDATE themes SET is_active=true WHERE slug='site-default'`);
  });
  await adapter.close();
  await otherAdapter.close();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.CAELO_FONTS_CACHE_DIR;
  await rm(join(process.cwd(), PREVIEW_CACHE), { recursive: true, force: true });
});

test("a preview reads each distinct face once and reads the site's texts whole only once", async () => {
  const preview = async () => {
    const reads = fontByteReadCount();
    const scans = wholeReads();
    const rows = deltaRows();
    const { html } = (await run("pages.render_preview", { pageId })) as { html: string };
    expect(html).toContain("@font-face");
    return {
      html,
      reads: fontByteReadCount() - reads,
      scans: wholeReads() - scans,
      rows: deltaRows() - rows,
    };
  };

  // Cold: one byte read for the one distinct face (bound to three roles),
  // one usage scan.
  const cold = await preview();
  expect(cold.reads).toBe(1);
  expect(cold.scans).toBe(1);

  // Warm and unchanged: no byte read, no scan, same output.
  const warm = await preview();
  expect(warm.reads).toBe(0);
  expect(warm.scans).toBe(0);
  expect(warm.html).toBe(cold.html);

  // Byte cache dropped (another instance, a restart): one read per face again.
  clearFontReaderCache();
  const reread = await preview();
  expect(reread.reads).toBe(1);
  expect(reread.scans).toBe(0);

  // A content change the scan covers is carried forward: the one changed
  // row is re-read, the site is not (#1270).
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:250}"));
  const changed = await preview();
  expect(changed.scans).toBe(0);
  expect(changed.rows).toBe(1);
  expect(changed.reads).toBe(0);
  expect(changed.html).not.toBe(cold.html);
  const again = await preview();
  expect(again.scans).toBe(0);
  expect(again.rows).toBe(0);
  expect(again.html).toBe(changed.html);
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:400}"));
});

test("preview and build produce identical font output from the shared cache", async () => {
  const resolveIn = (tx: TransactionRunner, publicBasePath: string) =>
    resolveThemeFonts({
      tokens,
      cacheDir,
      publicBasePath,
      readFont: fontReader(tx),
      loadFontUsage: () => loadSiteFontUsage(tx, tokens),
      preloadLanguage: "en",
      fetcher: (() => {
        throw new Error("Unexpected font network fetch");
      }) as typeof fetch,
    });
  const scans = wholeReads();
  const preview = await adapter.withAdminTransaction(ctx, (tx) => resolveIn(tx, "/_caelo/fonts"));
  const build = await adapter.withAdminTransaction(ctx, (tx) => resolveIn(tx, "/_assets/fonts"));
  expect(wholeReads() - scans).toBe(1); // the build reused the preview's read
  expect(preview.unresolved).toEqual([]);
  expect(build.files).toEqual(preview.files);
  expect(build.preloads).toEqual(
    preview.preloads.map((p) => p.replace("/_caelo/fonts", "/_assets/fonts")),
  );
  expect(build.css).toBe(preview.css.replaceAll("/_caelo/fonts", "/_assets/fonts"));
  // And identical to a build with every cache cold.
  clearSiteFontUsageCache();
  clearFontReaderCache();
  const coldBuild = await adapter.withAdminTransaction(ctx, (tx) =>
    resolveIn(tx, "/_assets/fonts"),
  );
  expect(coldBuild.css).toBe(build.css);
  expect(coldBuild.files).toEqual(build.files);
});

test("usage cache: a write later in the scanning transaction invalidates; a rolled-back one leaves nothing", async () => {
  const rollback = new Error("rollback");
  await expect(
    adapter.withAdminTransaction(ctx, async (tx) => {
      // Give the transaction its xid before the scan, as any earlier write
      // would, and let a newer transaction finish: Postgres then reports
      // this transaction's xid as visible in the scan's own snapshot (below
      // xmax, not in xip) — the case the cached `ownXid` exists for.
      await tx.execute(sql`SELECT pg_current_xact_id()`);
      await otherAdapter.withAdminTransaction(ctx, (other) =>
        other.execute(sql`SELECT pg_current_xact_id()`),
      );
      expect(await loadAndCompare(tx)).toBe(1);
      await loadSiteFontUsage(tx, tokens); // re-arm the cache from this transaction
      await setCaptionCss(tx, ".cap{font-weight:260}");
      // The cached entry predates this write: it must not be served.
      expect(await loadAndCompare(tx)).toBe(1);
      const own = await loadSiteFontUsage(tx, tokens);
      expect(own.weights).toContain(260);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  // The scan that saw the uncommitted write was never cached; what is
  // served now is the committed state.
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const usage = await loadSiteFontUsage(tx, tokens);
    expect(usage).toEqual(await uncached(tx));
    expect(usage.weights).not.toContain(260);
  });
});

test("usage cache: a write that commits after another transaction cached is seen", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let written!: () => void;
  const isWritten = new Promise<void>((resolve) => {
    written = resolve;
  });
  // Transaction A writes and stays open; B caches meanwhile; A commits.
  const writer = adapter.withAdminTransaction(ctx, async (tx) => {
    await setCaptionCss(tx, ".cap{font-weight:270}");
    written();
    await released;
  });
  await isWritten;
  await otherAdapter.withAdminTransaction(ctx, async (tx) => {
    const usage = await loadSiteFontUsage(tx, tokens);
    expect(usage.weights).not.toContain(270);
  });
  release();
  await writer;
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const scans = wholeReads();
    const rows = deltaRows();
    const usage = await loadSiteFontUsage(tx, tokens);
    // The write was in flight when B read: the delta from B's mark has it.
    expect(wholeReads() - scans).toBe(0);
    expect(deltaRows() - rows).toBe(1);
    expect(usage.weights).toContain(270);
    expect(await loadAndCompare(tx)).toBe(0);
  });
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:400}"));
});

test("usage cache: journal garbage collection past the cached mark forces a rescan (#1267)", async () => {
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await loadSiteFontUsage(tx, tokens);
  });
  // A content write after the scan, then GC with no retention (and no
  // stall window, so no other test's consumer holds it back): its journal
  // row goes too, so the horizon passes the cached scan's mark.
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:330}"));
  await adapter.withAdminTransaction(ctx, async (tx) => {
    expect(
      await collectJournalGarbage(tx, { retentionMs: 0, stalledConsumerMs: 0 }),
    ).toBeGreaterThan(0);
  });
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const scans = wholeReads();
    const usage = await loadSiteFontUsage(tx, tokens);
    // The rows the freshness check and a delta would need are gone: it
    // cannot carry the cache forward, so it reads whole instead of trusting it.
    expect(wholeReads() - scans).toBe(1);
    expect(usage).toEqual(await uncached(tx));
  });
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const scans = wholeReads();
    await loadSiteFontUsage(tx, tokens);
    expect(wholeReads() - scans).toBe(0);
  });
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:400}"));
});

test("usage cache: a write without font usage re-reads its row and keeps the scan (#1270)", async () => {
  const setBody = (tx: TransactionRunner, text: string) =>
    tx.execute(sql`
      UPDATE content_instances SET "values" = jsonb_build_object('body_text', ${text}::text)
       WHERE module_id = (SELECT id FROM modules WHERE display_name = ${`${TAG} body`})`);
  const first = await adapter.withAdminTransaction(ctx, (tx) => loadSiteFontUsage(tx, tokens));
  const scans = wholeReads();
  const rows = deltaRows();
  await adapter.withAdminTransaction(ctx, (tx) => setBody(tx, "Plain words"));
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const plain = await loadSiteFontUsage(tx, tokens);
    // The changed instance was read by id; its text has no font usage, so
    // the held texts are unchanged and the scan is not run again.
    expect({ whole: wholeReads() - scans, rows: deltaRows() - rows }).toEqual({
      whole: 0,
      rows: 1,
    });
    expect(plain).toBe(first);
    expect(plain).toEqual(await uncached(tx));
  });

  // The same row starting to carry a weight joins the held texts, and
  // leaving it again drops it; both by a delta of that one row.
  for (const [text, has] of [
    ['<b style="font-weight:850">x</b>', true],
    ["Plain again", false],
  ] as const) {
    await adapter.withAdminTransaction(ctx, (tx) => setBody(tx, text));
    await adapter.withAdminTransaction(ctx, async (tx) => {
      const before = { whole: wholeReads(), rows: deltaRows() };
      const usage = await loadSiteFontUsage(tx, tokens);
      expect({ whole: wholeReads() - before.whole, rows: deltaRows() - before.rows }).toEqual({
        whole: 0,
        rows: 1,
      });
      expect(usage.weights?.includes(850) ?? false).toBe(has);
      expect(usage).toEqual(await uncached(tx));
    });
  }
  await adapter.withAdminTransaction(ctx, (tx) => setBody(tx, "Hello"));
});

test("usage cache: a reader that already wrote scanned rows reads whole and caches nothing", async () => {
  await adapter.withAdminTransaction(ctx, (tx) => loadSiteFontUsage(tx, tokens));
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await setCaptionCss(tx, ".cap{font-weight:280}");
    const scans = wholeReads();
    const usage = await loadSiteFontUsage(tx, tokens);
    expect(wholeReads() - scans).toBe(1);
    expect(usage.weights).toContain(280);
    await setCaptionCss(tx, ".cap{font-weight:400}");
  });
  // Nothing of that transaction's view was kept: the next reader carries
  // the clean cache forward by the journal rows the commit left.
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const scans = wholeReads();
    const usage = await loadSiteFontUsage(tx, tokens);
    expect(wholeReads() - scans).toBe(0);
    expect(usage.weights).not.toContain(280);
    expect(usage).toEqual(await uncached(tx));
  });
});

// Codex review on #1219: concurrent first reads of one face each stored it,
// counting its bytes twice against the cache budget.
test("font byte cache: concurrent first reads of one face are counted once", async () => {
  clearFontReaderCache();
  const [a, b] = await Promise.all([
    adapter.withAdminTransaction(ctx, (tx) => fontReader(tx)(ref)),
    otherAdapter.withAdminTransaction(ctx, (tx) => fontReader(tx)(ref)),
  ]);
  expect(a.bytes.byteLength).toBe(b.bytes.byteLength);
  expect(fontReaderCachedBytes()).toBe(a.bytes.byteLength);
});
