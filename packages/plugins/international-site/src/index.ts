// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-international-site — i18n for Caelo, entirely as a
 * plugin (epic #380 Phase C; spec: CMS_REQUIREMENTS §7).
 *
 * The first real inhabitant of the composition-point foundation: all
 * logic lives HERE (no admin-core proxying — the deleted `translation`
 * facade proved that anti-pattern out), all data lives in the plugin's
 * own `plugin_international_site` schema in cms_admin (#389):
 *
 *   locales        — the registry: BCP-47 code, display name, URL
 *                    strategy (none | subdirectory | subdomain |
 *                    domain), optional host, default flag.
 *   page_variants  — EXPLICIT variant linkage: pages join a group_id;
 *                    localized slugs (`/de/preise`) are first-class
 *                    because linkage is never slug-derived.
 *   glossary/style — context for translation calls (#397).
 *
 * URL shape rides the #390 composition point: this plugin claims the
 * `path-prefix` and `host` slots. Non-default locales get `/<code>/`;
 * the default locale serves BARE (the "one variant without prefix"
 * requirement). Activating on an existing single-language site is a
 * ZERO-DIFF retrofit: every page starts without a variant row, the
 * annotation op reports the default locale, the prefix encodes to []
 * — no URL moves, no Owner click (#395).
 *
 * Purity note (decode): the #390 contract requires pure decode. The
 * registered locale codes live in this plugin's tables, so the module
 * keeps an in-memory code cache that every DB-touching operation
 * refreshes (url_annotations runs before ANY composition, so encodes
 * always see fresh data; a background worker keeps the cache warm for
 * standalone decode consumers).
 */

import {
  definePlugin,
  type PluginAdminQuery,
  type PluginContextTier1,
} from "@caelo-cms/plugin-sdk";

export interface LocaleRow {
  id: string;
  code: string;
  display_name: string;
  url_strategy: "none" | "subdirectory" | "subdomain" | "domain";
  url_host: string | null;
  is_default: boolean;
}

export interface PageVariantRow {
  id: string;
  group_id: string;
  page_id: string;
  locale_code: string;
  translation_status: "source" | "up_to_date" | "needs_update";
  source_event_cursor: number | null;
}

/**
 * In-memory mirror of the locales table for the PURE decode half of the
 * URL contributions. Refreshed by every operation that reads locales
 * (and by the staleness worker, #397) — never consulted for encoding,
 * which always receives fresh per-page annotations.
 */
const localeCache = new Map<string, LocaleRow>();

function adminQueryOf(ctx: unknown): PluginAdminQuery {
  const q = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!q) {
    throw new Error(
      "international-site: ctx.adminQuery missing — the cms_admin_schema capability was not granted",
    );
  }
  return q;
}

async function refreshLocaleCache(q: PluginAdminQuery): Promise<LocaleRow[]> {
  const rows = (await q.list("locales", { limit: 500 })) as unknown as LocaleRow[];
  localeCache.clear();
  for (const row of rows) localeCache.set(row.code, row);
  return rows;
}

async function loadVariantsByPage(
  q: PluginAdminQuery,
  pageIds: ReadonlyArray<string>,
): Promise<Map<string, PageVariantRow>> {
  const out = new Map<string, PageVariantRow>();
  // Bounded per-page lookups through the declared-column filter; page
  // counts per call are small (write-path recomputes) or batched by
  // the diff engine which tolerates the N queries.
  for (const pageId of pageIds) {
    const rows = (await q.list("page_variants", {
      page_id: pageId,
      limit: 1,
    })) as unknown as PageVariantRow[];
    const row = rows[0];
    if (row) out.set(pageId, row);
  }
  return out;
}

function defaultLocale(): LocaleRow | null {
  for (const row of localeCache.values()) {
    if (row.is_default) return row;
  }
  return null;
}

export default definePlugin<PluginContextTier1>({
  slug: "international-site",
  version: "0.1.0",
  tier: 1,
  // No cms_public tables — visitor-facing data (the language selector)
  // renders from published variant groups at build time (#398).
  schema: {},
  adminSchema: {
    locales: {
      code: "string",
      display_name: "string",
      url_strategy: "enum:none,subdirectory,subdomain,domain",
      url_host: "text",
      is_default: "bool",
      created_at: "timestamp",
    },
    page_variants: {
      group_id: "uuid",
      page_id: "ref:pages:cascade",
      locale_code: "string",
      translation_status: "enum:source,up_to_date,needs_update",
      source_event_cursor: "int",
      created_at: "timestamp",
    },
    glossary: {
      term: "string",
      locale_code: "string",
      translation: "string",
      context: "text",
      created_at: "timestamp",
    },
    style_guides: {
      locale_code: "string",
      body: "text",
      created_at: "timestamp",
    },
    settings: {
      key: "string",
      value: "jsonb",
      created_at: "timestamp",
    },
  },
  requestedCapabilities: [
    "cms_admin",
    "cms_admin_schema",
    "ai_provider",
    "chat_runner_tools",
    "background_workers",
    "domain_events",
    "head_contributions",
  ],
  operations: {
    /**
     * #390 I/O phase — per-page URL annotations from the variant table:
     * `{ locale, isDefaultLocale, urlStrategy }`. Pages without a
     * variant row belong to the default locale (the zero-diff retrofit
     * invariant); with NO locales registered at all, every page is
     * annotation-free and composes to its bare shape.
     */
    url_annotations: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const q = adminQueryOf(ctx);
      await refreshLocaleCache(q);
      const annotations: Record<string, Record<string, unknown>> = {};
      const def = defaultLocale();
      if (localeCache.size === 0) {
        for (const id of pageIds) annotations[id] = {};
        return { annotations };
      }
      const variants = await loadVariantsByPage(q, pageIds);
      for (const id of pageIds) {
        const variant = variants.get(id);
        const locale = variant ? localeCache.get(variant.locale_code) : def;
        if (!locale) {
          throw new Error(
            `international-site: page ${id} references locale "${variant?.locale_code}" which is not registered`,
          );
        }
        annotations[id] = {
          locale: locale.code,
          isDefaultLocale: locale.is_default,
          urlStrategy: locale.url_strategy,
          ...(locale.url_host ? { urlHost: locale.url_host } : {}),
        };
      }
      return { annotations };
    },

    /** Worker tick — keeps the decode-side locale cache warm. */
    refresh_locales: async (ctx) => {
      const rows = await refreshLocaleCache(adminQueryOf(ctx));
      return { locales: rows.length };
    },
  },
  workers: [
    {
      name: "locale-cache-refresh",
      cron: "0 * * * * *",
      operationName: "refresh_locales",
    },
  ],
  urlAnnotationsOperation: "url_annotations",
  urlContributions: [
    {
      slot: "path-prefix",
      encode: (page) => {
        const locale = page.annotations.locale;
        if (typeof locale !== "string") return [];
        const isDefault = page.annotations.isDefaultLocale === true;
        const strategy = page.annotations.urlStrategy;
        // The default locale serves BARE; only the subdirectory
        // strategy produces a path prefix (subdomain/domain ride the
        // host slot; "none" opts a locale out of URL shaping).
        if (isDefault || strategy !== "subdirectory") return [];
        return [locale];
      },
      decode: (segments) => {
        const head = segments[0];
        if (head === undefined) return null;
        const locale = localeCache.get(head);
        if (!locale || locale.is_default || locale.url_strategy !== "subdirectory") {
          return null;
        }
        return { consumed: 1, annotations: { locale: locale.code } };
      },
    },
    {
      slot: "host",
      encode: (page) => {
        const strategy = page.annotations.urlStrategy;
        if (strategy !== "subdomain" && strategy !== "domain") return null;
        const host = page.annotations.urlHost;
        if (typeof host !== "string" || host.length === 0) {
          // No-fallbacks: a host-strategy locale without a configured
          // host is a configuration error, not a silent bare URL.
          throw new Error(
            `international-site: locale "${String(page.annotations.locale)}" uses the ${String(strategy)} strategy but has no url_host configured`,
          );
        }
        return host;
      },
      decode: (host) => {
        for (const locale of localeCache.values()) {
          if (locale.url_host === host) {
            return { annotations: { locale: locale.code } };
          }
        }
        return null;
      },
    },
  ],
});
