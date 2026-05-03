// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — static plugin render pass.
 *
 * For every active Tier-1 plugin whose definition declares a
 * `staticRender(ctx, {pageId, locale}) => string`, this pass:
 *   1. Computes a cache key (plugin.version + page content hash).
 *   2. Skips render when the existing `static_bakes` row matches.
 *   3. On miss / on bust: calls the plugin via `runPluginStaticRender`,
 *      writes the row.
 *   4. Splices the rendered HTML into a stable
 *      `<div data-caelo-plugin="<slug>" data-page-id="<id>"
 *           data-locale="<loc>" data-baked-at="<iso>">` placeholder.
 *
 * Pages without the placeholder for a given plugin emit no HTML for it
 * (matches "you didn't put the widget on this page, so we don't render
 * it" UX).
 */

import {
  loadedPlugins,
  runPluginMetaSignature,
  runPluginMetaSignatureBatch,
  runPluginStaticRender,
} from "@caelo/plugin-host";
import type { DatabaseAdapter } from "@caelo/query-api";
import { sql } from "drizzle-orm";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "static-bake",
};

export interface BakeTarget {
  readonly pageId: string;
  readonly slug: string;
  readonly locale: string;
  readonly contentHash: string;
}

export interface BakedPage {
  html: string;
  pageSlug: string;
  pageLocale: string;
  pageTitle: string;
  relPath: string;
}

export interface PluginPassResult {
  readonly bakedCount: number;
  readonly skippedCount: number;
}

interface BakeRow {
  cache_key: string;
  rendered_html: string;
  baked_at: string | Date;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function placeholderRegex(slug: string, pageId: string): RegExp {
  return new RegExp(
    `<div\\s+data-caelo-plugin="${escapeForRegex(slug)}"[^>]*data-page-id="${escapeForRegex(pageId)}"[^>]*>(?:[\\s\\S]*?)<\\/div>`,
    "g",
  );
}

export async function runPluginRenderPass(args: {
  adapter: DatabaseAdapter;
  pages: BakedPage[];
  bakeTargets: ReadonlyMap<string, BakeTarget>;
}): Promise<PluginPassResult> {
  const { adapter, pages, bakeTargets } = args;

  const activePlugins = loadedPlugins
    .all()
    .filter((lp) => lp.tier === 1 && typeof lp.definition.staticRender === "function")
    .map((lp) => ({ id: lp.pluginId, slug: lp.slug, version: lp.version }));
  if (activePlugins.length === 0) return { bakedCount: 0, skippedCount: 0 };

  // P13 perf-pass — pre-resolve metaSignatures in batch per (slug, locale)
  // when the plugin exposes metaSignatureBatch. Saves N DB roundtrips on
  // large sites. Cache shape: Map<`${slug}:${locale}`, Map<pageId, sig>>.
  const batchedSigs = new Map<string, ReadonlyMap<string, string>>();
  const targetsByLocale = new Map<string, string[]>();
  for (const t of bakeTargets.values()) {
    const arr = targetsByLocale.get(t.locale) ?? [];
    arr.push(t.pageId);
    targetsByLocale.set(t.locale, arr);
  }
  for (const plugin of activePlugins) {
    for (const [locale, pageIds] of targetsByLocale) {
      try {
        const m = await runPluginMetaSignatureBatch({
          pluginSlug: plugin.slug,
          locale,
          pageIds,
        });
        if (m.size > 0) batchedSigs.set(`${plugin.slug}:${locale}`, m);
      } catch {
        // best-effort; per-page fallback handles failures.
      }
    }
  }

  let bakedCount = 0;
  let skippedCount = 0;

  for (const page of pages) {
    const target = bakeTargets.get(`${page.pageSlug}:${page.pageLocale}`);
    if (!target) continue;
    for (const plugin of activePlugins) {
      // P13 audit fix #4 — fold the plugin's own data signature into
      // the cache key so the bake refreshes when plugin data changes
      // even though page.content_hash didn't move (e.g. a comment got
      // approved). Plugins that don't declare metaSignature get "".
      // P13 perf-pass — prefer the pre-batched value when present.
      const batched = batchedSigs.get(`${plugin.slug}:${target.locale}`);
      const metaSig =
        batched?.get(target.pageId) ??
        (await runPluginMetaSignature({
          pluginSlug: plugin.slug,
          pageId: target.pageId,
          locale: target.locale,
        }).catch(() => ""));
      const cacheKey = `${plugin.version}:${target.contentHash}:${metaSig}`;

      const cached = await adapter.withAdminTransaction(
        SYSTEM_CTX,
        async (tx) =>
          (await tx.execute(sql`
          SELECT cache_key, rendered_html, baked_at
          FROM static_bakes
          WHERE plugin_id = ${plugin.id}::uuid
            AND page_id   = ${target.pageId}::uuid
            AND locale    = ${target.locale}
          LIMIT 1
        `)) as unknown as BakeRow[],
      );

      let html: string;
      let bakedAtIso: string;
      if (cached[0] && cached[0].cache_key === cacheKey) {
        html = cached[0].rendered_html;
        bakedAtIso =
          cached[0].baked_at instanceof Date
            ? cached[0].baked_at.toISOString()
            : String(cached[0].baked_at);
        skippedCount += 1;
      } else {
        try {
          const rendered = await runPluginStaticRender({
            pluginSlug: plugin.slug,
            pageId: target.pageId,
            locale: target.locale,
          });
          html = rendered ?? "";
        } catch {
          continue; // best-effort; failures don't kill the build
        }
        bakedAtIso = new Date().toISOString();
        await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
          await tx.execute(sql`
            INSERT INTO static_bakes (plugin_id, page_id, locale, baked_at, cache_key, rendered_html)
            VALUES (${plugin.id}::uuid, ${target.pageId}::uuid, ${target.locale}, ${bakedAtIso}, ${cacheKey}, ${html})
            ON CONFLICT (plugin_id, page_id, locale) DO UPDATE SET
              baked_at = EXCLUDED.baked_at,
              cache_key = EXCLUDED.cache_key,
              rendered_html = EXCLUDED.rendered_html
          `);
        });
        bakedCount += 1;
      }

      // Splice into the page's HTML at the placeholder. Re-build the
      // wrapper so data-baked-at is fresh + correct.
      const re = placeholderRegex(plugin.slug, target.pageId);
      page.html = page.html.replace(
        re,
        `<div data-caelo-plugin="${plugin.slug}" data-page-id="${target.pageId}" data-locale="${target.locale}" data-baked-at="${bakedAtIso}">${html}</div>`,
      );
    }
  }

  return { bakedCount, skippedCount };
}
