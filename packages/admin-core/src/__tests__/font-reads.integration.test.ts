// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #803 (epic #1209) — font work per preview against a real Postgres:
 *
 * - a preview reads each bound face's bytes once (cold process cache) or
 *   not at all (warm), never once per typography role;
 * - the site-wide font usage scan does not run while the scanned rows are
 *   unchanged, runs again after any change to them, and the cached result
 *   always equals what an uncached scan under the reader's snapshot gives —
 *   including writes made later in the scanning transaction, rolled-back
 *   writes, and a write that commits after another transaction cached;
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
  siteFontUsageScanCount,
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

/**
 * Load through the cache and assert it equals the uncached scan. Returns
 * the number of full scans the cached load ran; the comparison itself
 * leaves a fresh entry from `tx` in the cache.
 */
async function loadAndCompare(tx: TransactionRunner): Promise<number> {
  const before = siteFontUsageScanCount();
  const usage = await loadSiteFontUsage(tx, tokens);
  const misses = siteFontUsageScanCount() - before;
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

test("a preview reads each distinct face once and skips the usage scan while nothing changed", async () => {
  const preview = async () => {
    const reads = fontByteReadCount();
    const scans = siteFontUsageScanCount();
    const { html } = (await run("pages.render_preview", { pageId })) as { html: string };
    expect(html).toContain("@font-face");
    return {
      html,
      reads: fontByteReadCount() - reads,
      scans: siteFontUsageScanCount() - scans,
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

  // A content change the scan covers invalidates it exactly once.
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:250}"));
  const changed = await preview();
  expect(changed.scans).toBe(1);
  expect(changed.reads).toBe(0);
  const again = await preview();
  expect(again.scans).toBe(0);
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
  const scans = siteFontUsageScanCount();
  const preview = await adapter.withAdminTransaction(ctx, (tx) => resolveIn(tx, "/_caelo/fonts"));
  const build = await adapter.withAdminTransaction(ctx, (tx) => resolveIn(tx, "/_assets/fonts"));
  expect(siteFontUsageScanCount() - scans).toBe(1); // the build reused the preview's scan
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
    const scans = siteFontUsageScanCount();
    const usage = await loadSiteFontUsage(tx, tokens);
    expect(siteFontUsageScanCount() - scans).toBe(1);
    expect(usage.weights).toContain(270);
    expect(await loadAndCompare(tx)).toBe(0);
  });
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:400}"));
});

test("usage cache: journal garbage collection past the cached mark forces a rescan (#1267)", async () => {
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await loadSiteFontUsage(tx, tokens);
  });
  // A content write after the scan, then GC with no retention: its journal
  // row goes too, so the horizon passes the cached scan's mark.
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:330}"));
  await adapter.withAdminTransaction(ctx, async (tx) => {
    expect(await collectJournalGarbage(tx, { retentionMs: 0 })).toBeGreaterThan(0);
  });
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const scans = siteFontUsageScanCount();
    const usage = await loadSiteFontUsage(tx, tokens);
    // The rows the freshness check would need are gone: it cannot prove the
    // cache current, so it rescans instead of trusting it.
    expect(siteFontUsageScanCount() - scans).toBe(1);
    expect(usage).toEqual(await uncached(tx));
  });
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const scans = siteFontUsageScanCount();
    await loadSiteFontUsage(tx, tokens);
    expect(siteFontUsageScanCount() - scans).toBe(0);
  });
  await adapter.withAdminTransaction(ctx, (tx) => setCaptionCss(tx, ".cap{font-weight:400}"));
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
