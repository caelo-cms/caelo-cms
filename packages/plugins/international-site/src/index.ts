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

interface CmsHandle {
  call: <O>(opName: string, input: unknown) => Promise<O>;
}

function cmsOf(ctx: unknown): CmsHandle {
  const cms = (ctx as { cms?: CmsHandle }).cms;
  if (!cms) {
    throw new Error(
      "international-site: ctx.cms missing — the cms_admin capability was not granted",
    );
  }
  return cms;
}

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

/** Shared by link_page_variants and create_variant: join `pageId` into
 *  `groupPageId`'s variant group (minting the group with the anchor as
 *  source when none exists), then refresh the composed path. */
async function linkPageIntoGroup(
  ctx: unknown,
  args: { groupPageId: string; pageId: string; localeCode: string },
): Promise<{ groupId: string; path: string; pathMoved: boolean }> {
  const { groupPageId, pageId, localeCode } = args;
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  await refreshLocaleCache(q);
  if (!localeCache.has(localeCode)) {
    throw new Error(
      `locale "${localeCode}" is not registered — call set_locales first (list current codes via intl_status)`,
    );
  }
  const anchor = (await q.list("page_variants", {
    page_id: groupPageId,
    limit: 1,
  })) as unknown as PageVariantRow[];
  let groupId = anchor[0]?.group_id;
  if (!groupId) {
    // The anchor page starts its own group as the source variant.
    groupId = crypto.randomUUID();
    const def = defaultLocale();
    await q.insert("page_variants", {
      group_id: groupId,
      page_id: groupPageId,
      locale_code: def?.code ?? localeCode,
      translation_status: "source",
    });
  }
  const dupe = (await q.list("page_variants", {
    page_id: pageId,
    limit: 1,
  })) as unknown as PageVariantRow[];
  if (dupe[0]) {
    throw new Error(
      `page ${pageId} is already in variant group ${dupe[0].group_id} — unlink_page_variants first`,
    );
  }
  await q.insert("page_variants", {
    group_id: groupId,
    page_id: pageId,
    locale_code: localeCode,
    translation_status: "up_to_date",
  });
  // The locale annotation changed → the composed path may move.
  const refreshed = await cms.call<{ path: string; moved: boolean }>("pages.refresh_current_path", {
    pageId,
  });
  return { groupId, path: refreshed.path, pathMoved: refreshed.moved };
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

    /**
     * #396 — the AI's decision surface (CLAUDE.md §1A): the full
     * translation-state matrix in ONE call, so "is this page
     * translated?" never round-trips to the operator.
     */
    intl_status: async (ctx) => {
      const q = adminQueryOf(ctx);
      const cms = cmsOf(ctx);
      const locales = await refreshLocaleCache(q);
      const variants = (await q.list("page_variants", {
        limit: 1000,
      })) as unknown as PageVariantRow[];
      const pagesResult = await cms.call<{
        pages: { id: string; slug: string; title: string; status: string; currentPath: string }[];
      }>("pages.list", {});
      const pageById = new Map(pagesResult.pages.map((p) => [p.id, p]));

      const groups = new Map<string, Array<Record<string, unknown>>>();
      const linkedPageIds = new Set<string>();
      for (const v of variants) {
        const page = pageById.get(v.page_id);
        if (!page) continue; // deleted page — cascade lag
        linkedPageIds.add(v.page_id);
        const list = groups.get(v.group_id) ?? [];
        list.push({
          pageId: v.page_id,
          slug: page.slug,
          title: page.title,
          path: page.currentPath,
          pageStatus: page.status,
          locale: v.locale_code,
          translationStatus: v.translation_status,
        });
        groups.set(v.group_id, list);
      }

      const staleCounts: Record<string, number> = {};
      for (const v of variants) {
        if (v.translation_status === "needs_update") {
          staleCounts[v.locale_code] = (staleCounts[v.locale_code] ?? 0) + 1;
        }
      }

      return {
        locales: locales.map((l) => ({
          code: l.code,
          displayName: l.display_name,
          urlStrategy: l.url_strategy,
          urlHost: l.url_host,
          isDefault: l.is_default,
        })),
        groups: [...groups.entries()].map(([groupId, vs]) => ({ groupId, variants: vs })),
        // Pages without a variant row belong to the default locale and
        // have NO translations yet — the AI's to-do surface.
        unassignedPages: pagesResult.pages
          .filter((p) => !linkedPageIds.has(p.id))
          .map((p) => ({ pageId: p.id, slug: p.slug, title: p.title, path: p.currentPath })),
        staleCounts,
      };
    },

    /** Link an existing page into a variant group. */
    link_page_variants: async (ctx, args) =>
      linkPageIntoGroup(ctx, args as { groupPageId: string; pageId: string; localeCode: string }),

    /** Remove a page from its variant group (back to the default locale). */
    unlink_page_variants: async (ctx, args) => {
      const { pageId } = args as { pageId: string };
      const q = adminQueryOf(ctx);
      const cms = cmsOf(ctx);
      const rows = (await q.list("page_variants", {
        page_id: pageId,
        limit: 1,
      })) as unknown as PageVariantRow[];
      const row = rows[0];
      if (!row) {
        throw new Error(`page ${pageId} is not in any variant group — nothing to unlink`);
      }
      await q.delete("page_variants", row.id);
      const refreshed = await cms.call<{ path: string; moved: boolean }>(
        "pages.refresh_current_path",
        { pageId },
      );
      return { removedFromGroup: row.group_id, path: refreshed.path, pathMoved: refreshed.moved };
    },

    /**
     * Mint the counterpart page for a locale inside the source's group.
     * The slug is freely localizable (linkage is group_id, never
     * slug-derived); the new page lands as a DRAFT copy for #397's
     * translation pass (or manual editing).
     */
    create_variant: async (ctx, args) => {
      const { sourcePageId, localeCode, slug, title } = args as {
        sourcePageId: string;
        localeCode: string;
        slug: string;
        title?: string;
      };
      const q = adminQueryOf(ctx);
      const cms = cmsOf(ctx);
      await refreshLocaleCache(q);
      if (!localeCache.has(localeCode)) {
        throw new Error(`locale "${localeCode}" is not registered — call set_locales first`);
      }
      const duplicated = await cms.call<{ pageId: string }>("pages.duplicate", {
        sourcePageId,
        newSlug: slug,
        ...(title ? { newTitle: title } : {}),
      });
      const linked = await linkPageIntoGroup(ctx, {
        groupPageId: sourcePageId,
        pageId: duplicated.pageId,
        localeCode,
      });
      return { pageId: duplicated.pageId, ...linked };
    },

    /**
     * Replace the locale registry. APPROVAL-GATED at the tool layer
     * (#388): the SDK pauses for the Owner's in-chat click before this
     * runs. URL moves do NOT happen here — the tool description steers
     * the AI to propose_url_migration afterwards, keeping the two
     * blast radii separately approved.
     */
    set_locales: async (ctx, args) => {
      const { locales } = args as {
        locales: Array<{
          code: string;
          displayName: string;
          urlStrategy: "none" | "subdirectory" | "subdomain" | "domain";
          urlHost?: string;
          isDefault: boolean;
        }>;
      };
      if (!Array.isArray(locales) || locales.length === 0) {
        throw new Error("set_locales: pass the FULL desired locale list (min 1)");
      }
      const defaults = locales.filter((l) => l.isDefault);
      if (defaults.length !== 1) {
        throw new Error("set_locales: exactly one locale must be isDefault");
      }
      for (const l of locales) {
        if ((l.urlStrategy === "subdomain" || l.urlStrategy === "domain") && !l.urlHost) {
          throw new Error(
            `set_locales: locale "${l.code}" uses ${l.urlStrategy} and requires urlHost`,
          );
        }
      }
      const q = adminQueryOf(ctx);
      const existing = (await q.list("locales", { limit: 500 })) as unknown as LocaleRow[];
      const keep = new Set(locales.map((l) => l.code));
      for (const row of existing) {
        if (!keep.has(row.code)) await q.delete("locales", row.id);
      }
      const byCode = new Map(existing.map((r) => [r.code, r]));
      for (const l of locales) {
        const prev = byCode.get(l.code);
        if (prev) {
          await q.update("locales", prev.id, {
            display_name: l.displayName,
            url_strategy: l.urlStrategy,
            url_host: l.urlHost ?? null,
            is_default: l.isDefault,
          });
        } else {
          await q.insert("locales", {
            code: l.code,
            display_name: l.displayName,
            url_strategy: l.urlStrategy,
            url_host: l.urlHost ?? null,
            is_default: l.isDefault,
          });
        }
      }
      await refreshLocaleCache(q);
      return {
        locales: locales.length,
        nextStep:
          "Locale registry updated. If existing pages' URLs are affected, call propose_url_migration next — the Owner approves the move separately.",
      };
    },
  },
  workers: [
    {
      name: "locale-cache-refresh",
      cron: "0 * * * * *",
      operationName: "refresh_locales",
    },
  ],
  tools: [
    {
      name: "intl_status",
      description:
        "Fetch the FULL translation state in one call: registered locales (code, strategy, default flag), every variant group (which pages are language-counterparts of each other, with per-variant translation status and current path), pages not yet in any group (they belong to the default locale and have no translations), and per-locale stale counts. " +
        "Call this FIRST for any i18n question ('is X translated?', 'what is missing in German?') — never ask the operator. " +
        "NOT for changing anything: use create_variant / link_page_variants / set_locales to act.",
      operationName: "intl_status",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "create_variant",
      description:
        "Create the language counterpart of a page: duplicates the source page as a DRAFT, joins it into the source's variant group, and composes its URL (e.g. /de/<slug>). " +
        "The slug is freely localizable ('preise' for 'pricing') — linkage is by group, never by slug. " +
        "Use when a page has no variant in the target locale yet (check intl_status). The draft still carries the SOURCE language — run the translation flow next, then publish. " +
        "NOT for linking two ALREADY-EXISTING pages — that is link_page_variants.",
      operationName: "create_variant",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sourcePageId", "localeCode", "slug"],
        properties: {
          sourcePageId: { type: "string", format: "uuid" },
          localeCode: { type: "string", minLength: 2, maxLength: 35 },
          slug: { type: "string", minLength: 1, maxLength: 200 },
          title: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    {
      name: "link_page_variants",
      description:
        "Declare an EXISTING page to be the language counterpart of another existing page (joins it into the anchor's variant group and recomposes its URL, with a 301 from the old path when it moves). " +
        "Use when both pages already exist (e.g. after a site import). For a page that does not exist yet, use create_variant instead.",
      operationName: "link_page_variants",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["groupPageId", "pageId", "localeCode"],
        properties: {
          groupPageId: { type: "string", format: "uuid" },
          pageId: { type: "string", format: "uuid" },
          localeCode: { type: "string", minLength: 2, maxLength: 35 },
        },
      },
    },
    {
      name: "unlink_page_variants",
      description:
        "Remove a page from its variant group — it returns to the default locale (URL recomposed, 301 from the old path when it moves). The page itself is NOT deleted. " +
        "Undoes link_page_variants / the linkage half of create_variant.",
      operationName: "unlink_page_variants",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pageId"],
        properties: { pageId: { type: "string", format: "uuid" } },
      },
    },
    {
      name: "set_locales",
      description:
        "Replace the site's locale registry (pass the FULL desired list; exactly one isDefault; subdomain/domain strategies require urlHost). " +
        "APPROVAL-GATED: the turn pauses on an in-chat card and the operator clicks Approve before anything is written — say 'I prepared the locale change — please approve' and do NOT claim it is applied. " +
        "Changing locales does NOT move existing pages by itself: when URLs are affected, call propose_url_migration afterwards (a separately approved step with its own blast-radius preview).",
      operationName: "set_locales",
      approvalMode: "user-approval",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["locales"],
        properties: {
          locales: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "displayName", "urlStrategy", "isDefault"],
              properties: {
                code: { type: "string", minLength: 2, maxLength: 35 },
                displayName: { type: "string", minLength: 1, maxLength: 120 },
                urlStrategy: {
                  type: "string",
                  enum: ["none", "subdirectory", "subdomain", "domain"],
                },
                urlHost: { type: "string", minLength: 1, maxLength: 253 },
                isDefault: { type: "boolean" },
              },
            },
          },
        },
      },
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
