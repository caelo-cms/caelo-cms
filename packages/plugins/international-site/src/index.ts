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
  type PluginAi,
  type PluginContextTier1,
  type PluginEvents,
} from "@caelo-cms/plugin-sdk";
import {
  alignSlots,
  buildFullTranslationPrompt,
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
  validateStructuralLock(payload, alignment, mode);

  // Apply — merge translated strings over the variant's current values.
  const variantByKey = new Map(variantSlots.map((s) => [`${s.blockName}|${s.position}`, s]));
  let slotsApplied = 0;
  for (const slot of payload.slots) {
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
