// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — static plugin render pass.
 *
 * For every active Tier-1 plugin whose definition declares a
 * `staticRender(ctx, {pageId}) => string`, this pass:
 *   1. Computes a cache key (plugin.version + page content hash).
 *   2. Skips render when the existing `static_bakes` row matches.
 *   3. On miss / on bust: calls the plugin via `runPluginStaticRender`
 *      and writes the row.
 *   4. Splices the rendered HTML into a stable
 *      `<div data-caelo-plugin="<slug>" data-page-id="<id>"
 *           data-baked-at="<iso>">` placeholder, wrapped in the bake
 *      markers a plugin-data build re-renders between (bake-regions.ts,
 *      #1155).
 *
 * Pages without the placeholder for a given plugin emit no HTML for it
 * (matches "you didn't put the widget on this page, so we don't render
 * it" UX).
 *
 * The bake cache is read and written over the build's own transaction
 * (#1220): one bulk read of every row the pass can hit before it renders,
 * one bulk upsert of every fresh bake after. It used to open two
 * transactions per page and plugin from inside the build's transaction —
 * tens of thousands of nested checkouts of the same pool on a large site,
 * the deadlock class the pool guard refuses (query-api pool-guard.ts).
 * The renders themselves are calls back into the admin's plugin host
 * (cli.ts), which hold nothing of this transaction.
 */

import type { BuildPluginServices } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { PageUrlStyle } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { bakeRegion, neutralizeBakeMarkers } from "./bake-regions.js";

/**
 * Rows per bulk statement of the bake cache. Bounds one statement's
 * parameter size (rendered HTML travels in it) on a site with many pages.
 */
const BAKE_BATCH = 500;

export interface BakeTarget {
  readonly pageId: string;
  readonly slug: string;
}

export interface BakedPage {
  html: string;
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  relPath: string;
}

export interface PluginPassResult {
  readonly bakedCount: number;
  readonly skippedCount: number;
}

interface BakeRow {
  plugin_id: string;
  page_id: string;
  cache_key: string;
  rendered_html: string;
  baked_at: string | Date;
}

/** A fresh bake the pass writes back once every page is rendered. */
interface FreshBake {
  readonly plugin_id: string;
  readonly page_id: string;
  readonly baked_at: string;
  readonly cache_key: string;
  readonly rendered_html: string;
}

const bakeKey = (pluginId: string, pageId: string): string => `${pluginId}:${pageId}`;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A JSON value bound as one jsonb parameter (parsed by Postgres, not stored as a string). */
function jsonb(value: unknown): ReturnType<typeof sql> {
  return sql`(${JSON.stringify(value)}::text)::jsonb`;
}

/**
 * Every cached bake of the placed (plugin, page) pairs, keyed by
 * {@link bakeKey}, read in a few bulk statements.
 */
async function loadBakes(
  tx: TransactionRunner,
  placed: ReadonlyArray<{ readonly pluginId: string; readonly pageIds: readonly string[] }>,
): Promise<Map<string, BakeRow>> {
  const out = new Map<string, BakeRow>();
  for (const { pluginId, pageIds } of placed) {
    for (const ids of chunks(pageIds, BAKE_BATCH)) {
      const rows = (await tx.execute(sql`
        SELECT plugin_id::text AS plugin_id, page_id::text AS page_id,
               cache_key, rendered_html, baked_at
        FROM static_bakes
        WHERE plugin_id = ${pluginId}::uuid
          AND page_id IN (SELECT jsonb_array_elements_text(${jsonb(ids)})::uuid)
      `)) as unknown as BakeRow[];
      for (const row of rows) out.set(bakeKey(row.plugin_id, row.page_id), row);
    }
  }
  return out;
}

/**
 * Upsert every fresh bake in a few bulk statements. The rows stay locked
 * until the build commits, so they are written in one fixed order: two
 * builds at once (a Stage and an Owner's production build) then wait for
 * each other instead of deadlocking.
 */
async function storeBakes(tx: TransactionRunner, bakes: readonly FreshBake[]): Promise<void> {
  const ordered = [...bakes].sort((x, y) =>
    x.plugin_id === y.plugin_id
      ? x.page_id.localeCompare(y.page_id)
      : x.plugin_id.localeCompare(y.plugin_id),
  );
  for (const batch of chunks(ordered, BAKE_BATCH)) {
    await tx.execute(sql`
      INSERT INTO static_bakes (plugin_id, page_id, baked_at, cache_key, rendered_html)
      SELECT b.plugin_id, b.page_id, b.baked_at, b.cache_key, b.rendered_html
      FROM jsonb_to_recordset(${jsonb(batch)})
        AS b(plugin_id uuid, page_id uuid, baked_at timestamptz, cache_key text, rendered_html text)
      ON CONFLICT (plugin_id, page_id) DO UPDATE SET
        baked_at = EXCLUDED.baked_at,
        cache_key = EXCLUDED.cache_key,
        rendered_html = EXCLUDED.rendered_html
    `);
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this page carry the plugin's placeholder for itself? */
function hasPlaceholder(html: string, slug: string, pageId: string): boolean {
  return placeholderRegex(slug, pageId).test(html);
}

function placeholderRegex(slug: string, pageId: string): RegExp {
  return new RegExp(
    `<div\\s+data-caelo-plugin="${escapeForRegex(slug)}"[^>]*data-page-id="${escapeForRegex(pageId)}"[^>]*>(?:[\\s\\S]*?)<\\/div>`,
    "g",
  );
}

export async function runPluginRenderPass(args: {
  /** The build's transaction: the bake cache is read and written over it. */
  tx: TransactionRunner;
  /** #605 — the plugin host rendering the placeholders. */
  plugins: BuildPluginServices;
  pages: BakedPage[];
  /** Keyed by page id. */
  bakeTargets: ReadonlyMap<string, BakeTarget>;
  /** The target's page URL style, handed to every `staticRender`. */
  pageUrlStyle: PageUrlStyle;
}): Promise<PluginPassResult> {
  const { tx, plugins, pages, bakeTargets, pageUrlStyle } = args;

  // #1155 — a bake marker in the page itself (module HTML anyone wrote)
  // must never open or close a region a plugin-data build rewrites.
  for (const page of pages) page.html = neutralizeBakeMarkers(page.html);

  const activePlugins = await plugins.staticRenderPlugins();
  if (activePlugins.length === 0) return { bakedCount: 0, skippedCount: 0 };

  // P13 perf-pass — pre-resolve metaSignatures in one batch when the
  // plugin exposes metaSignatureBatch. Saves N DB roundtrips on large
  // sites. Cache shape: Map<pluginSlug, Map<pageId, sig>>.
  //
  // Only pages that carry the plugin's placeholder are asked about: a
  // page without the widget renders nothing for it, so a failure there
  // must not be able to stop the build.
  const placedPages = new Map<string, string[]>();
  for (const plugin of activePlugins) {
    const ids: string[] = [];
    for (const page of pages) {
      const target = bakeTargets.get(page.pageId);
      // A paginated overview's follow-up pages share its id (#1257): ask once.
      if (
        target &&
        !ids.includes(target.pageId) &&
        hasPlaceholder(page.html, plugin.slug, target.pageId)
      ) {
        ids.push(target.pageId);
      }
    }
    placedPages.set(plugin.slug, ids);
  }
  const batchedSigs = new Map<string, ReadonlyMap<string, string>>();
  for (const plugin of activePlugins) {
    const allPageIds = placedPages.get(plugin.slug) ?? [];
    if (allPageIds.length === 0) continue;
    // Empty for a plugin without the batch variant (per-page below).
    // A plugin that declares it and throws stops the build: a wrong
    // cache key would ship a stale bake as if it were current.
    const m = await plugins.metaSignatureBatch(plugin.slug, allPageIds);
    if (m.size > 0) batchedSigs.set(plugin.slug, m);
  }

  const cache = await loadBakes(
    tx,
    activePlugins.map((p) => ({ pluginId: p.id, pageIds: placedPages.get(p.slug) ?? [] })),
  );
  const fresh: FreshBake[] = [];

  let bakedCount = 0;
  let skippedCount = 0;
  // (plugin, page) → its region, so the follow-up pages of a paginated
  // overview (#1257) splice the same bake instead of rendering again.
  const regions = new Map<string, string>();

  for (const page of pages) {
    const target = bakeTargets.get(page.pageId);
    if (!target) continue;
    for (const plugin of activePlugins) {
      if (!(placedPages.get(plugin.slug) ?? []).includes(target.pageId)) continue;
      const regionKey = bakeKey(plugin.id, target.pageId);
      const done = regions.get(regionKey);
      if (done !== undefined) {
        page.html = page.html.replace(placeholderRegex(plugin.slug, target.pageId), () => done);
        continue;
      }
      // P13 audit fix #4 — the plugin's own data signature IS the
      // cache key (plus plugin version): plugin render output depends
      // on plugin data + pageId, not on the page's own content.
      // Plugins that don't declare metaSignature get "".
      // P13 perf-pass — prefer the pre-batched value when present.
      const batched = batchedSigs.get(plugin.slug);
      const metaSig =
        batched?.get(target.pageId) ?? (await plugins.metaSignature(plugin.slug, target.pageId));
      // The URL style is part of the key: a plugin linking to pages renders
      // different hrefs per style (#590).
      const cacheKey = `${plugin.version}:${pageUrlStyle}:${metaSig}`;

      const cached = cache.get(bakeKey(plugin.id, target.pageId));

      let html: string;
      let bakedAtIso: string;
      if (cached && cached.cache_key === cacheKey) {
        html = cached.rendered_html;
        bakedAtIso =
          cached.baked_at instanceof Date ? cached.baked_at.toISOString() : String(cached.baked_at);
        skippedCount += 1;
      } else {
        // Taken BEFORE the render: it becomes the delta feed's `since`
        // (§6.1), so an item that lands while the plugin reads its data is
        // fetched by the Web Component rather than lost between the two.
        bakedAtIso = new Date().toISOString();
        // A failing render stops the build (CLAUDE.md §2): the page would
        // otherwise ship an empty placeholder where the plugin belongs.
        try {
          html = await plugins.staticRender(plugin.slug, target.pageId, pageUrlStyle);
        } catch (e) {
          throw new Error(
            `static-generator: plugin "${plugin.slug}" staticRender failed for page ${target.pageId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        fresh.push({
          plugin_id: plugin.id,
          page_id: target.pageId,
          baked_at: bakedAtIso,
          cache_key: cacheKey,
          rendered_html: html,
        });
        bakedCount += 1;
      }

      // Splice into the page's HTML at the placeholder. Re-build the
      // wrapper so data-baked-at is fresh + correct, inside the markers.
      const re = placeholderRegex(plugin.slug, target.pageId);
      const region = bakeRegion({
        slug: plugin.slug,
        pageId: target.pageId,
        version: plugin.version,
        bakedAt: bakedAtIso,
        html,
      });
      regions.set(regionKey, region);
      page.html = page.html.replace(re, () => region);
    }
  }

  await storeBakes(tx, fresh);
  return { bakedCount, skippedCount };
}
