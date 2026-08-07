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

import { escapeHtml } from "@caelo-cms/plugin-component-kit";
import {
  definePlugin,
  type PluginAdminQuery,
  type PluginAi,
  type PluginContextTier1,
  type PluginEvents,
} from "@caelo-cms/plugin-sdk";
import {
  alignSlots,
  buildFullTranslationPrompt,
  buildSlotIndex,
  buildUpdateTranslationPrompt,
  type ContentSlot,
  type GlossaryEntry,
  stripJsonFence,
  translationResultPayload,
  validateStructuralLock,
} from "./translation.js";

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

function aiOf(ctx: unknown): PluginAi {
  const ai = (ctx as { ai?: PluginAi }).ai;
  if (!ai) {
    throw new Error(
      "international-site: ctx.ai missing — the ai_provider capability was not granted (Owner must configure an AI provider)",
    );
  }
  return ai;
}

function eventsOf(ctx: unknown): PluginEvents {
  const events = (ctx as { events?: PluginEvents }).events;
  if (!events) {
    throw new Error(
      "international-site: ctx.events missing — domain_events capability not granted",
    );
  }
  return events;
}

interface GlossaryRow {
  id: string;
  term: string;
  locale_code: string;
  translation: string;
  context: string | null;
}

interface StyleGuideRow {
  id: string;
  locale_code: string;
  body: string;
}

async function loadPlacements(cms: CmsHandle, pageId: string): Promise<ContentSlot[]> {
  const r = await cms.call<{
    placements: {
      blockName: string;
      position: number;
      moduleSlug: string;
      values: Record<string, unknown>;
    }[];
  }>("page_module_content.list_for_page", { pageId });
  return r.placements;
}

/**
 * #397 — one context-aware translation pass for a variant page. Whole
 * page in ONE ctx.ai call (never sentence-by-sentence); structural
 * lock validated post-hoc; the result lands on the DRAFT variant.
 */
async function translateVariantPage(
  ctx: unknown,
  args: { variantPageId: string; mode?: "auto" | "full" | "update" },
): Promise<{ mode: "full" | "update"; slotsApplied: number; titleApplied: boolean }> {
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const ai = aiOf(ctx);
  await refreshLocaleCache(q);

  const variantRows = (await q.list("page_variants", {
    page_id: args.variantPageId,
    limit: 1,
  })) as unknown as PageVariantRow[];
  const variantRow = variantRows[0];
  if (!variantRow) {
    throw new Error(
      `page ${args.variantPageId} is not in a variant group — create_variant / link_page_variants first`,
    );
  }
  const group = (await q.list("page_variants", {
    group_id: variantRow.group_id,
    limit: 100,
  })) as unknown as PageVariantRow[];
  const sourceRow = group.find((v) => v.translation_status === "source");
  if (!sourceRow) {
    throw new Error(
      `variant group ${variantRow.group_id} has no source variant — link the original page first`,
    );
  }
  if (sourceRow.page_id === args.variantPageId) {
    throw new Error("this page IS the source of its group — pick a target variant to translate");
  }
  const sourceLocale = localeCache.get(sourceRow.locale_code);
  const targetLocale = localeCache.get(variantRow.locale_code);
  if (!sourceLocale || !targetLocale) {
    throw new Error("group references locales that are no longer registered — fix via set_locales");
  }

  // Page titles via the open read surface.
  const pages = await cms.call<{ pages: { id: string; title: string }[] }>("pages.list", {});
  const sourceTitle = pages.pages.find((p) => p.id === sourceRow.page_id)?.title ?? "";
  const variantTitle = pages.pages.find((p) => p.id === args.variantPageId)?.title ?? "";

  const sourceSlots = await loadPlacements(cms, sourceRow.page_id);
  const variantSlots = await loadPlacements(cms, args.variantPageId);
  const alignment = alignSlots(sourceSlots, variantSlots);

  // Glossary + style guide for the TARGET locale.
  const glossaryRows = (await q.list("glossary", {
    locale_code: targetLocale.code,
    limit: 500,
  })) as unknown as GlossaryRow[];
  const glossary: GlossaryEntry[] = glossaryRows.map((g) => ({
    term: g.term,
    translation: g.translation,
    context: g.context,
  }));
  const styleRows = (await q.list("style_guides", {
    locale_code: targetLocale.code,
    limit: 1,
  })) as unknown as StyleGuideRow[];
  const styleGuide = styleRows[0]?.body ?? null;

  // Mode: a fresh clone still carries the source strings verbatim →
  // full; anything already (partially) translated → update, which
  // preserves human polish on slots the model omits.
  let mode: "full" | "update";
  if (args.mode === "full" || args.mode === "update") {
    mode = args.mode;
  } else {
    const untouched = alignment
      .filter((a) => a.kind === "aligned")
      .every(
        (a) =>
          a.kind === "aligned" &&
          JSON.stringify(a.source.values) === JSON.stringify(a.variant.values),
      );
    mode = untouched ? "full" : "update";
  }

  const prompt =
    mode === "full"
      ? buildFullTranslationPrompt({
          sourceLocale: sourceLocale.code,
          targetLocale: targetLocale.code,
          targetLocaleDisplayName: targetLocale.display_name,
          sourceTitle,
          sourceSlots,
          glossary,
          styleGuide,
        })
      : buildUpdateTranslationPrompt({
          sourceLocale: sourceLocale.code,
          targetLocale: targetLocale.code,
          targetLocaleDisplayName: targetLocale.display_name,
          sourceTitle,
          sourceSlots,
          variantTitle,
          variantSlots,
          alignment,
          glossary,
          styleGuide,
        });

  const result = await ai.complete({
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    maxTokens: 16_000,
  });
  let payload: ReturnType<typeof translationResultPayload.parse>;
  try {
    payload = translationResultPayload.parse(JSON.parse(stripJsonFence(result.text)));
  } catch (e) {
    throw new Error(
      `translation response did not match the contract: ${(e as Error).message}. Re-run translate_variant; if this repeats, the page may contain content the model cannot return as JSON.`,
    );
  }
  // The translator answers with opaque slot ids; resolve them back to
  // (blockName, position) here, against the very index the prompt was
  // built from.
  const slotIndex = buildSlotIndex(sourceSlots);
  validateStructuralLock(payload, alignment, mode, slotIndex);

  // Apply — merge translated strings over the variant's current values.
  const variantByKey = new Map(variantSlots.map((s) => [`${s.blockName}|${s.position}`, s]));
  let slotsApplied = 0;
  for (const entry of payload.slots) {
    const target = slotIndex.get(entry.slot);
    if (!target) continue; // validateStructuralLock already refused these
    const slot = { ...target, values: entry.values };
    const current = variantByKey.get(`${slot.blockName}|${slot.position}`);
    if (!current) continue; // full-mode 'added' slots have no variant placement — skip
    const merged = { ...current.values, ...slot.values };
    try {
      await cms.call("page_module_content.set", {
        pageId: args.variantPageId,
        blockName: slot.blockName,
        position: slot.position,
        contentValues: merged,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/synced/i.test(msg)) throw e;
      // A synced placement is shared with other pages — a translation
      // is by definition page-private, so fork first, then write.
      await cms.call("placement.fork_content", {
        pageId: args.variantPageId,
        blockName: slot.blockName,
        position: slot.position,
      });
      await cms.call("page_module_content.set", {
        pageId: args.variantPageId,
        blockName: slot.blockName,
        position: slot.position,
        contentValues: merged,
      });
    }
    slotsApplied += 1;
  }
  let titleApplied = false;
  if (payload.title && payload.title !== variantTitle) {
    await cms.call("pages.update", { pageId: args.variantPageId, title: payload.title });
    titleApplied = true;
  }
  await q.update("page_variants", variantRow.id, { translation_status: "up_to_date" });
  return { mode, slotsApplied, titleApplied };
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

interface PublishedVariant {
  pageId: string;
  localeCode: string;
  isDefault: boolean;
  href: string;
  /** The locale's operator-facing name ("Deutsch"), for switcher labels. */
  displayName: string;
}

/** Absolute URL for a variant. Path-strategy locales ride on the site
 *  base URL; host-strategy locales swap in their own host (scheme
 *  inherited from the base URL). */
function absoluteVariantUrl(siteBaseUrl: string, locale: LocaleRow, path: string): string {
  const base = new URL(siteBaseUrl);
  if (locale.url_host) return `${base.protocol}//${locale.url_host}${path}`;
  return `${base.origin}${path}`;
}

/**
 * #398 — per requested page: every PUBLISHED variant of its group with
 * its absolute URL. Pages outside any group, groups with fewer than
 * two published variants, and unpublished sole survivors contribute
 * nothing — hreflang only makes sense between real alternates.
 */
async function publishedVariantMatrix(
  ctx: unknown,
  pageIds: readonly string[],
  siteBaseUrl: string,
): Promise<Map<string, PublishedVariant[]>> {
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  await refreshLocaleCache(q);
  const out = new Map<string, PublishedVariant[]>();
  if (localeCache.size === 0) return out;

  const requested = new Set(pageIds);
  const allVariants = (await q.list("page_variants", {
    limit: 1000,
  })) as unknown as PageVariantRow[];
  const byGroup = new Map<string, PageVariantRow[]>();
  for (const v of allVariants) {
    const list = byGroup.get(v.group_id) ?? [];
    list.push(v);
    byGroup.set(v.group_id, list);
  }
  const pagesResult = await cms.call<{
    pages: { id: string; status: string; currentPath: string }[];
  }>("pages.list", {});
  const pageById = new Map(pagesResult.pages.map((p) => [p.id, p]));

  for (const group of byGroup.values()) {
    if (!group.some((v) => requested.has(v.page_id))) continue;
    const published: PublishedVariant[] = [];
    for (const v of group) {
      const page = pageById.get(v.page_id);
      if (page?.status !== "published") continue;
      const locale = localeCache.get(v.locale_code);
      if (!locale) {
        throw new Error(
          `international-site: variant group ${v.group_id} references unregistered locale "${v.locale_code}"`,
        );
      }
      published.push({
        pageId: v.page_id,
        localeCode: locale.code,
        isDefault: locale.is_default,
        href: absoluteVariantUrl(siteBaseUrl, locale, page.currentPath),
        displayName: locale.display_name,
      });
    }
    if (published.length < 2) continue;
    for (const v of group) {
      if (requested.has(v.page_id)) out.set(v.page_id, published);
    }
  }
  return out;
}

/**
 * The pages among `pageIds` that are the root of their own locale —
 * i.e. non-default-locale variants grouped with the site's designated
 * home page.
 *
 * Core knows one home; a multilingual site has one per locale. Core
 * cannot derive the rest (it has no locale concept since epic #380),
 * and the variant group is exactly the missing link, so the plugin
 * supplies it as a URL annotation and the composer honours it.
 */
async function localeRootPageIds(
  ctx: unknown,
  q: PluginAdminQuery,
  pageIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const cms = cmsOf(ctx);
  const defaults = await cms.call<{ defaults: { homePageId: string | null } | null }>(
    "site_defaults.get",
    {},
  );
  const homePageId = defaults.defaults?.homePageId ?? null;
  if (!homePageId) return out; // no designation: core's magic-slug rule stands
  const homeVariant = (
    (await q.list("page_variants", {
      page_id: homePageId,
      limit: 1,
    })) as unknown as PageVariantRow[]
  )[0];
  if (!homeVariant) return out; // home is not in any variant group
  const group = (await q.list("page_variants", {
    group_id: homeVariant.group_id,
    limit: 100,
  })) as unknown as PageVariantRow[];
  const requested = new Set(pageIds);
  for (const v of group) {
    // The designated home keeps core's own root handling; only its
    // counterparts need the annotation.
    if (v.page_id !== homePageId && requested.has(v.page_id)) out.add(v.page_id);
  }
  return out;
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
      // Which of these pages is the home page IN ITS OWN LOCALE. The
      // site has exactly one designated home (site_defaults), so core
      // composes every other page as `<prefix>/<slug>` — which put the
      // German home at `/de/startseite` instead of `/de/`. A live run
      // hit this and did the only thing available to it: tried to give
      // the variant the sentinel slug `home`, which is unique
      // site-wide, and collided with the English home. The locale root
      // is variant-group knowledge, so it is answered here rather than
      // worked around by duplicating a slug.
      const homeVariantIds = await localeRootPageIds(ctx, q, pageIds);
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
          ...(homeVariantIds.has(id) ? { isLocaleRoot: true } : {}),
        };
      }
      return { annotations };
    },

    /**
     * Resolver for the `language_links` data list. Batched over the
     * pages of one render pass, mirroring `head_contributions` — the
     * same published-variant matrix feeds both, so the visible switcher
     * and the hreflang tags can never disagree about what is published.
     */
    language_links: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const cms = cmsOf(ctx);
      const seo = await cms.call<{ siteBaseUrl: string }>("site_defaults.get_seo", {});
      const matrix = await publishedVariantMatrix(ctx, pageIds, seo.siteBaseUrl);
      const lists: Record<string, Record<string, Array<Record<string, string>>>> = {};
      for (const pageId of pageIds) {
        const variants = matrix.get(pageId);
        lists[pageId] = {
          // An absent group yields an empty list, not a missing one:
          // "this page has no alternates" is data the module should be
          // allowed to render nothing for.
          language_links: (variants ?? []).map((v) => ({
            href: v.href,
            label: v.displayName,
            locale: v.localeCode,
            // String, not boolean — data-list values are flat strings so
            // they substitute cleanly; a module tests it with a section.
            is_current: v.pageId === pageId ? "true" : "",
          })),
        };
      }
      return { lists };
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
        slug?: string;
        title?: string;
      };
      const q = adminQueryOf(ctx);
      const cms = cmsOf(ctx);
      await refreshLocaleCache(q);
      if (!localeCache.has(localeCode)) {
        throw new Error(`locale "${localeCode}" is not registered — call set_locales first`);
      }

      // Is the source the site's home? Then its counterpart is the ROOT
      // of its locale (`/de`), and the slug never reaches the URL —
      // which is precisely why the slug must not be the AI's problem
      // here. Slugs went globally unique with #384, so the obvious
      // expression of "this is the German homepage" — reusing the
      // source's own `home` — collides with the English page and leaves
      // the AI improvising renames that cannot succeed either.
      const defaults = await cms.call<{ defaults: { homePageId: string | null } | null }>(
        "site_defaults.get",
        {},
      );
      const isLocaleRoot = defaults.defaults?.homePageId === sourcePageId;

      const pages = await cms.call<{ pages: { id: string; slug: string }[] }>("pages.list", {});
      const sourceSlug = pages.pages.find((p) => p.id === sourcePageId)?.slug;
      if (!sourceSlug) {
        throw new Error(`source page ${sourcePageId} not found — check intl_status for page ids`);
      }

      // A locale root gets a derived, guaranteed-unique slug; anything
      // the caller passed would be ignored, so refuse it rather than
      // silently drop it (CLAUDE.md §2).
      if (isLocaleRoot && slug !== undefined) {
        throw new Error(
          `create_variant: "${sourceSlug}" is the site's home page, so its ${localeCode} counterpart is the root of that locale and resolves at "/${localeCode}" — its slug never appears in a URL. Omit \`slug\` and it is derived automatically.`,
        );
      }
      if (!isLocaleRoot && slug === undefined) {
        throw new Error(
          `create_variant: this page is not the site home, so the slug IS its URL segment under /${localeCode}/. Pass a localized slug (e.g. "ueber-uns" for "about"). Slugs are unique site-wide — the locale prefix comes from the locale's URL strategy, not from the slug.`,
        );
      }
      const newSlug = slug ?? `${sourceSlug}-${localeCode}`;

      let duplicated: { pageId: string };
      try {
        duplicated = await cms.call<{ pageId: string }>("pages.duplicate", {
          sourcePageId,
          newSlug,
          ...(title ? { newTitle: title } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Re-frame core's slug collision into the decision the caller
        // actually has to make; the raw message reads as "the page
        // already exists", which invites a pointless retry.
        if (msg.includes("page already exists for slug=")) {
          throw new Error(
            `create_variant: slug "${newSlug}" is already taken. Slugs are unique across the WHOLE site, not per locale (#384) — the "/${localeCode}/" prefix comes from the locale's URL strategy, not from the slug. Pick a localized slug that is free (e.g. "${sourceSlug}-${localeCode}").`,
          );
        }
        throw e;
      }

      const linked = await linkPageIntoGroup(ctx, {
        groupPageId: sourcePageId,
        pageId: duplicated.pageId,
        localeCode,
      });
      return { pageId: duplicated.pageId, slug: newSlug, isLocaleRoot, ...linked };
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

    /**
     * #397 — translate one variant page. ONE context-aware AI call for
     * the whole page (glossary + style guide included); NEVER
     * sentence-by-sentence. Modes: full (fresh clone) / update
     * (source changed after a translation existed) — auto-detected.
     */
    translate_variant: async (ctx, args) =>
      translateVariantPage(
        ctx,
        args as { variantPageId: string; mode?: "auto" | "full" | "update" },
      ),

    /**
     * #397 — bulk pass over every needs_update variant. Pauses (not
     * fails) when the plugin's 24h AI cost cap is hit, reporting what
     * remains so the AI can tell the operator instead of silently
     * half-finishing.
     */
    translate_all_stale: async (ctx) => {
      const q = adminQueryOf(ctx);
      const stale = (await q.list("page_variants", {
        translation_status: "needs_update",
        limit: 500,
      })) as unknown as PageVariantRow[];
      const translated: string[] = [];
      const failed: Array<{ pageId: string; error: string }> = [];
      let paused = false;
      for (const row of stale) {
        try {
          await translateVariantPage(ctx, { variantPageId: row.page_id });
          translated.push(row.page_id);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.startsWith("PluginAiCapExceeded:")) {
            // Pause-on-overage: the cap is the Owner's budget decision,
            // not an error in the work — stop cleanly, report the rest.
            paused = true;
            break;
          }
          failed.push({ pageId: row.page_id, error: msg });
        }
      }
      return {
        translated: translated.length,
        failed,
        paused,
        remaining: stale.length - translated.length - failed.length,
        ...(paused
          ? {
              nextStep:
                "The plugin's 24h AI budget is exhausted. Tell the operator; the Owner can raise the cap at /security/plugins/international-site, then re-run translate_all_stale.",
            }
          : {}),
      };
    },

    /** #397 — upsert a glossary term for a target locale. */
    set_glossary_term: async (ctx, args) => {
      const { term, localeCode, translation, context } = args as {
        term: string;
        localeCode: string;
        translation: string;
        context?: string;
      };
      const q = adminQueryOf(ctx);
      await refreshLocaleCache(q);
      if (!localeCache.has(localeCode)) {
        throw new Error(`locale "${localeCode}" is not registered — call set_locales first`);
      }
      const existing = (await q.list("glossary", {
        term,
        locale_code: localeCode,
        limit: 1,
      })) as unknown as GlossaryRow[];
      const prev = existing[0];
      if (prev) {
        await q.update("glossary", prev.id, { translation, context: context ?? null });
        return { glossaryId: prev.id, updated: true };
      }
      const row = (await q.insert("glossary", {
        term,
        locale_code: localeCode,
        translation,
        context: context ?? null,
      })) as { id: string };
      return { glossaryId: row.id, updated: false };
    },

    /** #397 — set (replace) the style guide for a target locale. */
    set_style_guide: async (ctx, args) => {
      const { localeCode, body } = args as { localeCode: string; body: string };
      const q = adminQueryOf(ctx);
      await refreshLocaleCache(q);
      if (!localeCache.has(localeCode)) {
        throw new Error(`locale "${localeCode}" is not registered — call set_locales first`);
      }
      const existing = (await q.list("style_guides", {
        locale_code: localeCode,
        limit: 1,
      })) as unknown as StyleGuideRow[];
      const prev = existing[0];
      if (prev) {
        await q.update("style_guides", prev.id, { body });
        return { styleGuideId: prev.id, updated: true };
      }
      const row = (await q.insert("style_guides", { locale_code: localeCode, body })) as {
        id: string;
      };
      return { styleGuideId: row.id, updated: false };
    },

    /**
     * #398 — head + sitemap contributions (#391 points). Per published
     * page in a multi-variant group: `<link rel="alternate" hreflang>`
     * for EVERY published variant including itself, plus x-default on
     * the default locale's variant; sitemap alternates mirror the same
     * set (byte-parity between generator and preview comes free — both
     * consume collectContributions).
     */
    head_contributions: async (ctx, args) => {
      const { pageIds, siteBaseUrl } = args as { pageIds: string[]; siteBaseUrl: string };
      const matrix = await publishedVariantMatrix(ctx, pageIds, siteBaseUrl);
      const head: Record<string, unknown[]> = {};
      const sitemap: Record<string, unknown> = {};
      for (const [pageId, variants] of matrix) {
        const entries: unknown[] = variants.map((v) => ({
          kind: "link",
          rel: "alternate",
          hreflang: v.localeCode,
          href: v.href,
        }));
        const def = variants.find((v) => v.isDefault);
        if (def) {
          entries.push({ kind: "link", rel: "alternate", hreflang: "x-default", href: def.href });
        }
        head[pageId] = entries;
        sitemap[pageId] = {
          alternates: [
            ...variants.map((v) => ({ hreflang: v.localeCode, href: v.href })),
            ...(def ? [{ hreflang: "x-default", href: def.href }] : []),
          ],
        };
      }
      return { head, sitemap };
    },

    /**
     * #397 worker tick — consume the domain-event outbox and mark
     * sibling variants of edited SOURCE pages needs_update. Branch
     * writes (payload.chatBranchId) are skipped: staleness starts when
     * the change lands on main (page.updated on publish/merge carries
     * no branch id). At-least-once delivery is safe — the mark is
     * idempotent.
     */
    translation_staleness_tick: async (ctx) => {
      const q = adminQueryOf(ctx);
      const events = eventsOf(ctx);
      const batch = await events.poll({
        kinds: ["page.updated", "page.published"],
        limit: 200,
      });
      if (batch.events.length === 0) return { marked: 0, scanned: 0 };
      const sourcePageIds = new Set<string>();
      for (const ev of batch.events) {
        const payload = ev.payload as { chatBranchId?: string | null };
        if (payload?.chatBranchId) continue;
        sourcePageIds.add(ev.entityId);
      }
      let marked = 0;
      for (const pageId of sourcePageIds) {
        const rows = (await q.list("page_variants", {
          page_id: pageId,
          limit: 1,
        })) as unknown as PageVariantRow[];
        const row = rows[0];
        if (row?.translation_status !== "source") continue;
        const siblings = (await q.list("page_variants", {
          group_id: row.group_id,
          limit: 100,
        })) as unknown as PageVariantRow[];
        for (const sib of siblings) {
          if (sib.id === row.id || sib.translation_status === "needs_update") continue;
          await q.update("page_variants", sib.id, {
            translation_status: "needs_update",
            source_event_cursor: batch.nextCursor,
          });
          marked += 1;
        }
      }
      await events.commit(batch.nextCursor);
      return { marked, scanned: batch.events.length };
    },
  },
  workers: [
    {
      name: "locale-cache-refresh",
      cron: "0 * * * * *",
      operationName: "refresh_locales",
    },
    {
      name: "translation-staleness",
      cron: "*/30 * * * * *",
      operationName: "translation_staleness_tick",
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
        "The slug is freely localizable ('preise' for 'pricing') — linkage is by group, never by slug. Slugs are unique across the WHOLE site, not per locale: the '/de/' prefix comes from the locale's URL strategy, so never reuse the source page's own slug. " +
        "OMIT `slug` when the source is the site's HOME page — its counterpart is the root of its locale ('/de'), carries no URL segment, and gets a derived slug automatically. Passing one there is an error. " +
        "Use when a page has no variant in the target locale yet (check intl_status). The draft still carries the SOURCE language — run the translation flow next, then publish. " +
        "NOT for linking two ALREADY-EXISTING pages — that is link_page_variants.",
      operationName: "create_variant",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sourcePageId", "localeCode"],
        properties: {
          sourcePageId: { type: "string", format: "uuid" },
          localeCode: { type: "string", minLength: 2, maxLength: 35 },
          slug: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "Localized URL segment under /<locale>/. Required for an ordinary page; MUST be omitted when the source is the site home.",
          },
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
    {
      name: "translate_variant",
      description:
        "Translate ONE variant page from its group's source language — the whole page in a single context-aware pass (module layout locked; glossary + style guide applied; existing human-polished translations preserved where the source did not change). " +
        "Use after create_variant (the draft still carries the source language) and for any variant intl_status marks needs_update. The result stays a DRAFT — review, then publish. " +
        "NOT for many pages at once — prefer translate_all_stale. NOT for the group's source page itself.",
      operationName: "translate_variant",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["variantPageId"],
        properties: {
          variantPageId: { type: "string", format: "uuid" },
          mode: {
            type: "string",
            enum: ["auto", "full", "update"],
            description:
              "auto (default) picks full for untranslated clones, update to refresh an existing translation after source edits.",
          },
        },
      },
    },
    {
      name: "translate_all_stale",
      description:
        "Re-translate EVERY variant marked needs_update (source pages changed after translation) in one call. Prefer this over repeated translate_variant calls when intl_status shows stale counts > 1. " +
        "If the plugin's 24h AI budget runs out mid-pass, the result carries paused=true + remaining — tell the operator instead of retrying; the Owner can raise the cap at /security/plugins/international-site.",
      operationName: "translate_all_stale",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "set_glossary_term",
      description:
        "Pin the exact translation of a term for a target locale (e.g. 'checkout' → 'Kasse' for de). Every future translation into that locale uses it verbatim. " +
        "Use when the operator corrects a translated word or names brand/product terminology ('never translate our product name'). One call per term+locale; re-calling updates the entry.",
      operationName: "set_glossary_term",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["term", "localeCode", "translation"],
        properties: {
          term: { type: "string", minLength: 1, maxLength: 200 },
          localeCode: { type: "string", minLength: 2, maxLength: 35 },
          translation: { type: "string", minLength: 1, maxLength: 500 },
          context: {
            type: "string",
            maxLength: 500,
            description:
              "Optional disambiguation shown to the translator (e.g. 'the e-commerce checkout, not a cash register').",
          },
        },
      },
    },
    {
      name: "set_style_guide",
      description:
        "Set the tone/style instructions applied to every translation into a locale (formality like du/Sie, register, phrasing conventions). Replaces the previous guide for that locale. " +
        "Use when the operator states a preference ('use informal du on the German site'). For single-word fixes use set_glossary_term instead.",
      operationName: "set_style_guide",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["localeCode", "body"],
        properties: {
          localeCode: { type: "string", minLength: 2, maxLength: 35 },
          body: { type: "string", minLength: 1, maxLength: 10000 },
        },
      },
    },
  ],
  /**
   * #398 — the language selector. Pure build-time HTML (no client JS):
   * a nav of links to every published variant of the page's group.
   * Placed by dropping the plugin placeholder into a module; pages
   * with fewer than two published variants render nothing.
   */
  staticRender: async (ctx, { pageId }) => {
    const cms = cmsOf(ctx);
    const seo = await cms.call<{ siteBaseUrl: string }>("site_defaults.get_seo", {});
    const matrix = await publishedVariantMatrix(ctx, [pageId], seo.siteBaseUrl);
    const variants = matrix.get(pageId);
    if (!variants) return "";
    const items = variants
      .map((v) => {
        const locale = localeCache.get(v.localeCode);
        const label = escapeHtml(locale?.display_name ?? v.localeCode);
        const current = v.pageId === pageId ? ' aria-current="page"' : "";
        return `<li><a href="${escapeHtml(v.href)}" hreflang="${escapeHtml(v.localeCode)}"${current}>${label}</a></li>`;
      })
      .join("");
    return `<nav class="caelo-language-selector" aria-label="Language"><ul>${items}</ul></nav>`;
  },
  contributes: ["head", "sitemap"],
  /**
   * The visible counterpart to the hreflang links: the same published
   * variants, as DATA for a module to iterate. `staticRender` below
   * still ships a ready-made switcher for operators who want one
   * without authoring markup, but a module using this list carries the
   * site's own design and — because it resolves per page — can live in
   * the LAYOUT and cover every page from one placement.
   */
  dataLists: [
    {
      name: "language_links",
      description:
        "Every PUBLISHED language version of the current page, including the current one. Empty when the page has fewer than two published variants — a lone language needs no switcher.",
      itemFields: ["href", "label", "locale", "is_current"],
    },
  ],
  dataListsOperation: "language_links",
  contributionsOperation: "head_contributions",
  /**
   * #399 — companion skills (CLAUDE.md §2: skills are the official way
   * to teach AI behaviour; no prompt scaffolding in tool handlers).
   * Registered at awaiting_activation; the Owner's site-wide click and
   * per-chat engagement follow the standard two-level model.
   */
  skills: [
    {
      slug: "translate-page",
      displayName: "Translate a page",
      description:
        "How to translate pages between the site's languages: variant groups, the one-call context-aware translation flow, and capturing the operator's terminology corrections.",
      body: [
        "You are translating pages on a multilingual Caelo site. The operator speaks in outcomes ('translate the pricing page into German') — never ask them about modules, variants, or groups.",
        "",
        "Flow:",
        "1. Call intl_status FIRST. It answers every 'is X translated / what is missing' question.",
        "2. If the target-language counterpart does not exist yet: create_variant with a LOCALIZED slug ('preise' for 'pricing', not 'pricing-de'). For the site's HOME page omit the slug entirely — its counterpart is the locale root ('/de') and has no URL segment. The draft still carries the source language.",
        "3. Call translate_variant on the counterpart. It translates the WHOLE page in one context-aware pass — title and every content field — honouring the site glossary and style guide. Never translate field-by-field yourself, and never edit shared module HTML to translate it: module code is shared across pages, content lives in per-page values.",
        "4. The result stays a DRAFT. Summarise what was translated and let the operator review before publishing.",
        "5. When intl_status shows stale variants (source pages changed after translation), prefer ONE translate_all_stale call over repeated translate_variant calls.",
        "",
        "When the operator corrects a translated word ('we say Kasse, not Checkout') or names brand terms, persist it with set_glossary_term so every future translation uses it. Tone preferences ('use informal du') go to set_style_guide. Apply the correction to already-translated pages by re-running translate_variant afterwards.",
      ].join("\n"),
      autoEngagementHints: {
        keywords: ["translate", "translation", "übersetze", "übersetzen", "language", "sprache"],
      },
    },
    {
      slug: "add-language",
      displayName: "Add a language to the site",
      description:
        "How to introduce a new locale end-to-end: the approval-gated locale registry, the separately approved URL migration, and seeding translated variants.",
      body: [
        "You are adding a language to a Caelo site. This is a TWO-APPROVAL flow — never claim a step is applied before the operator clicked.",
        "",
        "1. Call intl_status to see the current registry.",
        "2. Call set_locales with the FULL desired list (existing locales + the new one; exactly one isDefault). The turn pauses for the Owner's in-chat Approve. Pick the URL strategy from what the operator wants: subdirectory (/de/...) is the safe default; subdomain/domain need urlHost.",
        "3. If existing pages' URLs are affected by the change, call propose_url_migration next — it previews the URL fan-out and the 301 redirects, and the Owner approves it SEPARATELY.",
        "4. Seed the language: for each core page the operator cares about, create_variant with a localized slug (omit the slug for the home page — its counterpart is the locale root), then translate_variant. Do not mass-create variants for every page unprompted — ask which pages matter, or start with the pages the operator named.",
        "5. hreflang links and sitemap alternates appear automatically once variants are PUBLISHED (drafts are invisible to search engines by design — a missing translation is a clean 404, never a fallback).",
        '6. To offer visitors a language switcher, add a module whose HTML iterates the plugin\'s list: `<nav>{{#language_links}}<a href="{{href}}" hreflang="{{locale}}">{{label}}</a>{{/language_links}}</nav>`. Each item carries href, label, locale and is_current. Write the markup to match the site\'s design — you own it, the plugin only supplies the data. Because it resolves per page, placing that module in the LAYOUT gives every page a switcher from one placement. The list is empty until a page has at least two PUBLISHED variants.',
      ].join("\n"),
      autoEngagementHints: {
        keywords: [
          "add language",
          "new language",
          "neue sprache",
          "locale",
          "multilingual",
          "mehrsprachig",
          "international",
        ],
      },
    },
    {
      slug: "localize-slugs",
      displayName: "Localize page URLs",
      description:
        "How to give translated pages native-language URLs: slugs are freely localizable because variant linkage is by group, never derived from the slug.",
      body: [
        "You are localizing page URLs on a multilingual Caelo site. Linkage between language counterparts is an explicit group — NEVER derived from matching slugs — so every variant's slug can (and should) be in its own language.",
        "",
        "1. Call intl_status. Variants whose slug still matches the source language ('/de/pricing' instead of '/de/preise') are the work list.",
        "2. For each, change the slug with the standard page-slug tool. The 301 redirect from the old path is created automatically, and the variant group linkage is untouched by slug changes.",
        "3. Translate the slug meaningfully — a native speaker's word, lowercase, dash-separated. Reuse the glossary's terminology where it applies.",
        "4. Do NOT rename the source page's slug as part of this task, and do not unlink/relink variants to 'fix' URLs — the group is already correct.",
      ].join("\n"),
      autoEngagementHints: {
        keywords: ["slug", "localize url", "url übersetzen", "localized urls", "pretty urls"],
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
