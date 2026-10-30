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
 * requirement) unless the site-wide `prefixDefaultLocale` setting is
 * on — then it is prefixed too and only its home stays at `/` (rules
 * in ./url.ts). Activating on an existing single-language site is a
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
  type AiWorkItem,
  definePlugin,
  isAiDelegated,
  type ListTypeDef,
  type PageUrlStyle,
  type PluginAdminQuery,
  type PluginAi,
  type PluginContextTier1,
  type PluginWrite,
  z,
} from "@caelo-cms/plugin-sdk";
import {
  APPLY_TRANSLATIONS_TOOL,
  applyTranslations,
  applyTranslationsInputJsonSchema,
  chromeWorkItem,
  pageWorkItem,
  WORK_ITEM_NEXT_STEP,
} from "./apply-translations.js";
import { auditFindings } from "./audit.js";
import {
  type ChromeDeps,
  chromeStatus,
  chromeTranslationBasis,
  prepareChromeTranslation,
  reattachChromeVariant,
  reattachChromeVariantDelegated,
  refreshChromeStaleness,
  resolveChromeVariants,
  setChromeVariants,
  translateChrome,
} from "./chrome-ops.js";
import { languageToolbarState } from "./editor-toolbar.js";
import { chromeLinkLocations } from "./link-locations.js";
import { resolveListOverlays } from "./list-resolve.js";
import { entryStates, LIST_EXT_FIELD_SCHEMA } from "./list-translation.js";
import {
  lastLiveBuildAt,
  listFindings,
  listStatus,
  loadListTranslationState,
  reconcileListTranslations,
  setListItemVisibility,
} from "./list-translation-ops.js";
import {
  currentSourceFingerprint,
  type GlossaryRow,
  loadPageSource,
  outcomeNextStep,
  pageSourceFingerprint,
  pageTranslationBasis,
  preparePageTranslation,
  SEO_STALE_NEXT_STEP,
  SHARED_NESTED_NEXT_STEP,
  type StyleGuideRow,
  translateVariantPage,
} from "./page-translation.js";
import { batchIn, onceIn, renderMemoOf } from "./render-memo.js";
import { chunked, listAll, listWhereAnyOf, STORE_READ_MAX } from "./store-reads.js";
import { writeHints } from "./write-hints.js";

/**
 * The serving target's page URL style core hands every render-time
 * operation (#590). Parsed, not cast: a core that stopped passing it
 * must fail here, not build URLs in a guessed style.
 */
const renderUrlArgs = z.object({ pageUrlStyle: z.enum(["directory", "no-extension"]) });

/** What core's write-hints hook passes (plugin-sdk `PluginWriteHintsArgs`). */
const writeHintsArgs = z
  .object({
    writes: z.array(
      z.union([
        z
          .object({
            kind: z.literal("module"),
            moduleId: z.string().nullable(),
            html: z.string(),
            fields: z.array(z.record(z.string(), z.unknown())),
          })
          .strict(),
        z
          .object({
            kind: z.literal("values"),
            moduleId: z.string().nullable(),
            values: z.record(z.string(), z.unknown()),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

function pageUrlStyleOf(args: unknown): PageUrlStyle {
  return renderUrlArgs.parse(args).pageUrlStyle;
}

import {
  decodeLocalePrefix,
  defaultLocaleRootRedirect,
  encodeLocalePrefix,
  PREFIX_DEFAULT_LOCALE_ANNOTATION,
  prefixDefaultLocaleError,
} from "./url.js";

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
  /**
   * #1267 — fingerprint of the source page's translatable content when
   * this variant became up to date (`pageSourceFingerprint`); null for a
   * source row and for a variant made before #1267.
   */
  source_hash: string | null;
  created_at: string;
}

/**
 * In-memory mirror of the locales table for the PURE decode half of the
 * URL contributions. Refreshed by every operation that reads locales
 * (and by the staleness worker, #397) — never consulted for encoding,
 * which always receives fresh per-page annotations.
 */
const localeCache = new Map<string, LocaleRow>();

/**
 * Mirror of the `prefix_default_locale` setting, refreshed together with
 * {@link localeCache} — the pure decode half needs it, encode receives
 * it per page as an annotation.
 */
let prefixDefaultLocaleCache = false;

/** `settings` row key of the site-wide "prefix the default locale too"
 *  switch. Absent row = off (the original bare-default behaviour). */
const PREFIX_DEFAULT_LOCALE_KEY = "prefix_default_locale";

interface SettingRow {
  id: string;
  key: string;
  value: unknown;
}

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

/** What the host hands the change consumer (`PluginChangesArgs`, #1267). */
const stalenessChangesArgs = z.object({
  chatBranchId: z.string().uuid().nullable(),
  changes: z
    .array(
      z.object({
        kind: z.string(),
        op: z.enum(["insert", "update", "delete", "truncate"]),
        rowId: z.string(),
        parentId: z.string().nullable(),
      }),
    )
    .max(500),
});

/**
 * #1267 — prefix of a `source_hash` the backfill adopted (the source's
 * content when the backfill ran) rather than one a translation recorded.
 * The backfill cannot know whether a change committed just before it read
 * the source was already delivered, so a variant carrying one is flagged by
 * any change to its source, as before #1267; a rebuild compares the
 * fingerprint, so an unchanged source stays up to date.
 */
const BACKFILLED_HASH = "backfill:";

/** `settings` key recording that the source-hash backfill ran. */
const SOURCE_HASH_BACKFILL_KEY = "source_hash_backfill";

/** The fingerprint a stored `source_hash` holds, without the backfill prefix. */
function storedFingerprint(hash: string | null): string | null {
  if (hash === null) return null;
  return hash.startsWith(BACKFILLED_HASH) ? hash.slice(BACKFILLED_HASH.length) : hash;
}

/**
 * Group id → its source page's fingerprint now, memoised for one pass; null
 * when the group has no source, or its source page is deleted. Either way
 * there is nothing to compare a translation with, so callers leave the
 * group's variants as they are: a deleted source's translations are not
 * "out of date", and an undo of the delete makes them comparable again.
 */
function sourceHashesOf(
  deps: Pick<ChromeDeps, "q" | "cms" | "listTypes">,
): (groupId: string) => Promise<string | null> {
  const known = new Map<string, string | null>();
  return async (groupId) => {
    const hit = known.get(groupId);
    if (hit !== undefined) return hit;
    const source = (
      (await deps.q.list("page_variants", {
        group_id: groupId,
        translation_status: "source",
        limit: 1,
      })) as unknown as PageVariantRow[]
    )[0];
    const content = source ? await loadPageSource(deps, source.page_id, deps.listTypes) : null;
    const hash = content ? await pageSourceFingerprint(content) : null;
    known.set(groupId, hash);
    return hash;
  };
}

/**
 * #1267 — the backfill of `page_variants.source_hash` (rule 3: every
 * derived structure has one). Every variant that is up to date and has no
 * hash (translated before #1267) adopts its source's current fingerprint,
 * so neither the first rebuild nor the first source change after the
 * upgrade flags a translation nobody touched. Variants already
 * `needs_update` stay as they are.
 *
 * Runs once, from onActivate, and only while the plugin's change cursor is
 * continuous: then every change since the variants were last checked is
 * delivered after this, and flags them (see {@link BACKFILLED_HASH}). With
 * the cursor gone (a fresh or repeated activation) the rebuild decides
 * instead, and a later activation finishes the backfill.
 *
 * @returns how many variants got a hash, or null when it did not run.
 */
async function backfillSourceHashes(ctx: unknown): Promise<number | null> {
  const q = adminQueryOf(ctx);
  const done = (await q.list("settings", {
    key: SOURCE_HASH_BACKFILL_KEY,
    limit: 1,
  })) as unknown as SettingRow[];
  if (done[0]) return null;
  const state = await cmsOf(ctx).call<{ continuous: boolean }>("plugin_changes.cursor_state", {});
  if (!state.continuous) return null;
  const deps = await chromeDepsOf(ctx);
  const sourceHashOf = sourceHashesOf(deps);
  let filled = 0;
  for (let afterId: string | undefined; ; ) {
    const rows = (await q.list("page_variants", {
      translation_status: "up_to_date",
      orderBy: "id",
      limit: 1000,
      ...(afterId ? { afterId } : {}),
    })) as unknown as PageVariantRow[];
    for (const row of rows) {
      if (row.source_hash !== null) continue;
      const current = await sourceHashOf(row.group_id);
      // No source to compare with (none, or deleted): left as it is.
      if (current === null) continue;
      await q.update("page_variants", row.id, { source_hash: `${BACKFILLED_HASH}${current}` });
      filled += 1;
    }
    if (rows.length < 1000) break;
    afterId = rows.at(-1)?.id;
  }
  // Retired-outbox work outstanding at the upgrade (0430 marks its page
  // part): chrome and list statuses are re-derived from their stored
  // hashes, which covers module and list events the outbox still held.
  await refreshChromeStaleness(deps);
  await reconcileListTranslations(deps, await lastLiveBuildAt(deps));
  await q.insert("settings", { key: SOURCE_HASH_BACKFILL_KEY, value: { filled } });
  return filled;
}

/**
 * Of these possibly changed pages, the SOURCE pages: mark each up-to-date
 * sibling variant `needs_update` whose `source_hash` no longer matches the
 * source's content (#1267). The comparison is with the content, not with
 * the delivery, so a change delivered after the translation it preceded
 * flags nothing, and the rebuild decides exactly the same way. A sibling
 * without a hash, or with a backfilled one, is flagged by any change.
 */
async function markSiblingsStale(
  deps: Pick<ChromeDeps, "q" | "cms" | "listTypes">,
  sourcePageIds: Iterable<string>,
): Promise<number> {
  const { q } = deps;
  let marked = 0;
  for (const pageId of sourcePageIds) {
    const rows = (await q.list("page_variants", {
      page_id: pageId,
      limit: 1,
    })) as unknown as PageVariantRow[];
    const row = rows[0];
    if (row?.translation_status !== "source") continue;
    const siblings = (
      (await q.list("page_variants", {
        group_id: row.group_id,
        limit: 100,
      })) as unknown as PageVariantRow[]
    ).filter((sib) => sib.id !== row.id && sib.translation_status === "up_to_date");
    if (siblings.length === 0) continue;
    // A deleted source (a soft delete keeps the linkage) is no basis: its
    // variants stay as they are, and the rest of the batch goes on.
    const content = await loadPageSource(deps, pageId, deps.listTypes);
    if (!content) continue;
    const current = await pageSourceFingerprint(content);
    for (const sib of siblings) {
      // A backfilled hash (BACKFILLED_HASH) is no basis for a delivered
      // change: the change may predate the backfill's read.
      if (sib.source_hash === current) continue;
      await q.update("page_variants", sib.id, { translation_status: "needs_update" });
      marked += 1;
    }
  }
  return marked;
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

interface LocaleRegistry {
  rows: LocaleRow[];
  byCode: Map<string, LocaleRow>;
  prefixDefaultLocale: boolean;
}

/**
 * The locale registry, fresh — or, inside one render pass, the one this
 * pass already read (#1213): a preview asks five composition points for
 * the same page and every one of them needs the registry.
 */
function refreshLocaleCache(q: PluginAdminQuery, ctx?: unknown): Promise<LocaleRegistry> {
  return onceIn(renderMemoOf(ctx), "locales", () => readLocaleRegistry(q, ctx));
}

async function readLocaleRegistry(q: PluginAdminQuery, ctx?: unknown): Promise<LocaleRegistry> {
  const rows = (await q.list("locales", { limit: 500 })) as unknown as LocaleRow[];
  const byCode = new Map<string, LocaleRow>();
  for (const row of rows) byCode.set(row.code, row);
  const prefixDefaultLocale = (await loadPrefixDefaultLocaleSetting(q)).enabled;
  const isBranch = Boolean(
    (ctx as { invocation?: { chatBranchId?: string } } | undefined)?.invocation?.chatBranchId,
  );
  if (!isBranch) {
    localeCache.clear();
    for (const [k, v] of byCode) localeCache.set(k, v);
    prefixDefaultLocaleCache = prefixDefaultLocale;
  }
  return { rows, byCode, prefixDefaultLocale };
}

/**
 * Read the `prefix_default_locale` setting. A row whose value is not the
 * shape this plugin writes is schema drift — fail loudly instead of
 * guessing a URL shape (CLAUDE.md §2).
 */
async function loadPrefixDefaultLocaleSetting(
  q: PluginAdminQuery,
): Promise<{ enabled: boolean; rowId: string | null }> {
  const rows = (await q.list("settings", {
    key: PREFIX_DEFAULT_LOCALE_KEY,
    limit: 1,
  })) as unknown as SettingRow[];
  const row = rows[0];
  if (!row) return { enabled: false, rowId: null };
  const value = row.value as { enabled?: unknown } | null;
  if (typeof value?.enabled !== "boolean") {
    throw new Error(
      `international-site: setting "${PREFIX_DEFAULT_LOCALE_KEY}" holds ${JSON.stringify(row.value)}, expected {"enabled": boolean}. Re-run set_locales with prefixDefaultLocale to rewrite it.`,
    );
  }
  return { enabled: value.enabled, rowId: row.id };
}

/**
 * The variant row of each page that has one. One `anyOf` read per 1000
 * pages (#1213 — it used to be one read per page, which a build of the
 * whole site paid for every page); within a render pass, a page read once
 * is not read again.
 */
async function loadVariantsByPage(
  q: PluginAdminQuery,
  pageIds: ReadonlyArray<string>,
  ctx?: unknown,
): Promise<Map<string, PageVariantRow>> {
  const byPage = await batchIn<PageVariantRow | null>(renderMemoOf(ctx), "variantByPage").getMany(
    pageIds,
    async (missing) => {
      // A page is at most one variant, so the table holds no more rows
      // than the site has translated pages. Past one batch of ids (a
      // preview asks for every page of the site), paging the table is at
      // most as many reads as the batches and does not grow with the
      // untranslated pages (#1212 cost test).
      const rows = (
        missing.length > STORE_READ_MAX
          ? await listAll(q, "page_variants")
          : await listWhereAnyOf(q, "page_variants", "page_id", missing)
      ) as PageVariantRow[];
      const asked = new Set(missing);
      return new Map(rows.filter((r) => asked.has(r.page_id)).map((r) => [r.page_id, r]));
    },
    null,
  );
  const out = new Map<string, PageVariantRow>();
  for (const [pageId, row] of byPage) if (row) out.set(pageId, row);
  return out;
}

/** Every variant row of each group, batched and per-pass memoised like
 *  {@link loadVariantsByPage}. */
async function loadGroupMembers(
  q: PluginAdminQuery,
  groupIds: ReadonlyArray<string>,
  ctx?: unknown,
): Promise<Map<string, PageVariantRow[]>> {
  return batchIn<PageVariantRow[]>(renderMemoOf(ctx), "groupMembers").getMany(
    groupIds,
    async (missing) => {
      const rows = (await listWhereAnyOf(
        q,
        "page_variants",
        "group_id",
        missing,
      )) as PageVariantRow[];
      // In the order the variants joined the group (the source first): the
      // order hreflang, sitemap alternates and the switcher list them in.
      rows.sort(
        (a, b) =>
          Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const byGroup = new Map<string, PageVariantRow[]>();
      for (const r of rows) byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r]);
      return byGroup;
    },
    [],
  );
}

function defaultLocale(locales: ReadonlyMap<string, LocaleRow> = localeCache): LocaleRow | null {
  for (const row of locales.values()) {
    if (row.is_default) return row;
  }
  return null;
}

/**
 * The locale each page belongs to: its variant row's locale, or the
 * default locale for pages outside any variant group (the zero-diff
 * retrofit invariant). Empty when no locales are registered — then the
 * plugin has no opinion about any page. Expects a fresh locale cache.
 */
async function localesByPage(
  q: PluginAdminQuery,
  pageIds: readonly string[],
  locales: ReadonlyMap<string, LocaleRow> = localeCache,
  ctx?: unknown,
): Promise<Map<string, LocaleRow>> {
  const out = new Map<string, LocaleRow>();
  if (locales.size === 0) return out;
  const def = defaultLocale(locales);
  const variants = await loadVariantsByPage(q, pageIds, ctx);
  for (const id of pageIds) {
    const variant = variants.get(id);
    const locale = variant ? locales.get(variant.locale_code) : def;
    if (!locale) {
      throw new Error(
        `international-site: page ${id} references locale "${variant?.locale_code}" which is not registered`,
      );
    }
    out.set(id, locale);
  }
  return out;
}

/**
 * Epic #724 (rollout D) — this plugin's answer at core's link-resolve
 * composition point: every page's language (its variant row's locale, or
 * the default locale for pages outside any group — the zero-diff
 * retrofit invariant) and its variant group. Core then sends every
 * internal link on a page to the linked page's version in that page's
 * language, in module HTML, rich text, link fields, menus and chrome
 * alike. Empty when no locales are registered: one language, nothing
 * to map. #1213 — reads the variant rows of exactly the asked pages (one
 * read per 1000), so a caller that asks only for the pages a render
 * references pays for those, and a build asking for the whole site pays
 * one read per 1000 pages.
 */
async function pageVariantPartition(
  q: PluginAdminQuery,
  pageIds: readonly string[],
  locales: ReadonlyMap<string, LocaleRow>,
  ctx?: unknown,
): Promise<Record<string, { variant: string; group: string | null }>> {
  const out: Record<string, { variant: string; group: string | null }> = {};
  if (locales.size === 0) return out;
  const def = defaultLocale(locales);
  if (!def) {
    throw new Error(
      "international-site: locales are registered but none is the default — set_locales with exactly one isDefault",
    );
  }
  const rowByPage = await loadVariantsByPage(q, pageIds, ctx);
  for (const id of pageIds) {
    const row = rowByPage.get(id);
    if (!row) {
      out[id] = { variant: def.code, group: null };
      continue;
    }
    if (!locales.has(row.locale_code)) {
      throw new Error(
        `international-site: page ${id} references locale "${row.locale_code}" which is not registered`,
      );
    }
    out[id] = { variant: row.locale_code, group: row.group_id };
  }
  return out;
}

const linkResolveArgs = z.object({ pageIds: z.array(z.string().uuid()) }).strict();

/** What the chrome and page translation operations need, with a fresh
 *  locale registry (#592, #741). */
async function chromeDepsOf(ctx: unknown): Promise<ChromeDeps> {
  const q = adminQueryOf(ctx);
  const reg = await refreshLocaleCache(q, ctx);
  const cms = cmsOf(ctx);
  // Epic #1107 — local lists in chrome are read with their list types
  // (which entry fields are text is the type's to say). Once per render
  // pass (#1213): content_variants and list_resolve both need them.
  const types = await onceIn(renderMemoOf(ctx), "listTypes", () =>
    cms.call<{ listTypes: { slug: string; definition: ListTypeDef }[] }>("list_types.list", {}),
  );
  return {
    q,
    cms,
    locales: reg.byCode,
    listTypes: new Map(types.listTypes.map((t) => [t.slug, t.definition])),
  };
}

/**
 * #690 — the page in `localeCode` that is `pageId`'s language
 * counterpart: a member of its variant group, or the page itself when it
 * is in no group and `localeCode` is the default locale (ungrouped pages
 * belong to the default locale). Null when no such page exists yet.
 */
async function counterpartInLocale(
  q: PluginAdminQuery,
  pageId: string,
  localeCode: string,
  ctx?: unknown,
): Promise<string | null> {
  const reg = await refreshLocaleCache(q, ctx);
  const variant = (await loadVariantsByPage(q, [pageId], ctx)).get(pageId);
  if (!variant) return defaultLocale(reg.byCode)?.code === localeCode ? pageId : null;
  if (variant.locale_code === localeCode) return pageId;
  const rows = (await q.list("page_variants", {
    group_id: variant.group_id,
    locale_code: localeCode,
    limit: 1,
  })) as unknown as PageVariantRow[];
  return rows[0]?.page_id ?? null;
}

/**
 * Refuse to drop a locale that live pages still carry. Every URL and
 * render path resolves a variant's locale through the registry and fails
 * loudly on an unknown code, so dropping one strands its pages: their
 * paths can no longer be composed (merges, URL migrations, refreshes and
 * builds all stop on them).
 */
async function assertRemovedLocalesUnused(
  q: PluginAdminQuery,
  cms: CmsHandle,
  removedCodes: readonly string[],
): Promise<void> {
  if (removedCodes.length === 0) return;
  const livePageIds = new Set(
    (await cms.call<{ pages: { id: string }[] }>("pages.list", {})).pages.map((p) => p.id),
  );
  for (const code of removedCodes) {
    const rows = (await listAll(q, "page_variants", {
      locale_code: code,
    })) as unknown as PageVariantRow[];
    const used = rows.filter((r) => livePageIds.has(r.page_id)).map((r) => r.page_id);
    if (used.length > 0) {
      throw new Error(
        `set_locales: locale "${code}" is still used by ${used.length} page(s) (${used.slice(0, 5).join(", ")}${used.length > 5 ? ", …" : ""}). Delete those pages (delete_pages_many) or unlink them (unlink_page_variants) first, then call set_locales again — or keep "${code}" in the list.`,
      );
    }
  }
}

/** A throwaway slug for the copy while it has no locale prefix yet (see
 *  create_variant): random, so it never collides with a real page. */
function provisionalSlug(slug: string, localeCode: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  // Core slugs are at most 64 chars: slug ≤ 40 + "-" + locale ≤ 12 +
  // "-" + 10-char nonce = 64. A trailing hyphen never results (the
  // nonce ends it).
  const locale = localeCode
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const base = slug.slice(0, 40).replace(/-+$/, "");
  return `${base}-${locale}-${nonce}`;
}

/**
 * The page core serves at the site root — core's own verdict
 * (`site_defaults.get` → `rootPageId`): the designated home, or, with
 * no designation, the top-level magic-slug page (`home`). Asking the
 * designation alone disagreed with core on every site whose home is the
 * magic-slug page: core served it at "/", the operator and the AI
 * called it the home, and create_variant refused the slug-less call its
 * own tool description prescribes for the home.
 */
async function siteHomePageId(cms: CmsHandle): Promise<string | null> {
  const defaults = await cms.call<{ defaults: { rootPageId: string | null } | null }>(
    "site_defaults.get",
    {},
  );
  return defaults.defaults?.rootPageId ?? null;
}

/** Shared by link_page_variants and create_variant: join `pageId` into
 *  `groupPageId`'s variant group (minting the group with the anchor as
 *  source when none exists), then refresh the composed path. */
async function linkPageIntoGroup(
  ctx: unknown,
  args: {
    groupPageId: string;
    pageId: string;
    localeCode: string;
    /** "skip" for a page whose pre-link URL was never public (a
     *  provisional copy) — its old URL must not get a redirect. */
    redirectFromOld?: "auto" | "skip";
  },
): Promise<{ groupId: string; path: string; pathMoved: boolean }> {
  const { groupPageId, pageId, localeCode } = args;
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const reg = await refreshLocaleCache(q, ctx);
  if (!reg.byCode.has(localeCode)) {
    throw new Error(
      `locale "${localeCode}" is not registered — call set_locales first (list current codes via intl_status)`,
    );
  }
  // #690 — joining the HOME page's group makes the page its locale's
  // root ("/de"). A root has no parent and no child pages: a nested page
  // would keep its parent chain, and children under a root would stop
  // extending their parent's URL. Refuse before writing anything.
  if ((await siteHomePageId(cms)) === groupPageId) {
    const listed = await cms.call<{
      pages: { id: string; currentPath: string; parentPageId: string | null }[];
    }>("pages.list", {});
    const target = listed.pages.find((p) => p.id === pageId);
    const children = listed.pages.filter((p) => p.parentPageId === pageId);
    if (target?.parentPageId) {
      throw new Error(
        `page ${target.currentPath} sits under another page, but the home page's ${localeCode} counterpart is that locale's root — move it to the top level first (move_pages with parent null), then link it`,
      );
    }
    if (children.length > 0) {
      throw new Error(
        `page ${target?.currentPath ?? pageId} has ${children.length} child page(s), but the home page's ${localeCode} counterpart is that locale's root and cannot have child pages — move them first (move_pages), then link it`,
      );
    }
  }
  const anchor = (await q.list("page_variants", {
    page_id: groupPageId,
    limit: 1,
  })) as unknown as PageVariantRow[];
  let groupId = anchor[0]?.group_id;
  if (!groupId) {
    // The anchor page starts its own group as the source variant.
    groupId = crypto.randomUUID();
    const def = defaultLocale(reg.byCode);
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
  // A linked page is taken as translated as it stands: its basis is the
  // group source's content now (#1267).
  const sourceRows = (await q.list("page_variants", {
    group_id: groupId,
    translation_status: "source",
    limit: 1,
  })) as unknown as PageVariantRow[];
  const sourcePageId = sourceRows[0]?.page_id;
  if (!sourcePageId) {
    throw new Error(
      `variant group ${groupId} has no source variant — link the original page first`,
    );
  }
  await q.insert("page_variants", {
    group_id: groupId,
    page_id: pageId,
    locale_code: localeCode,
    translation_status: "up_to_date",
    source_hash: await currentSourceFingerprint({ cms }, sourcePageId),
  });
  // The locale annotation changed → the composed path may move.
  const refreshed = await cms.call<{ path: string; moved: boolean }>("pages.refresh_current_path", {
    pageId,
    redirectFromOld: args.redirectFromOld ?? "auto",
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

/**
 * #398 — per requested page: every PUBLISHED variant of its group with
 * its absolute URL. Pages outside any group, groups with fewer than
 * two published variants, and unpublished sole survivors contribute
 * nothing — hreflang only makes sense between real alternates.
 *
 * #590 — the URLs come from core (`pages.resolve_public_urls`), never
 * from this plugin: core's builder is the one that produces each page's
 * canonical, so every hreflang, sitemap alternate and switcher link is
 * byte-identical to the canonical of the page it points at — trailing
 * slash per the serving target's `pageUrlStyle`, host per the locale's
 * host strategy, canonical override honoured. (It also fails loudly
 * when the site base URL is unset, #551.)
 */
async function publishedVariantMatrix(
  ctx: unknown,
  pageIds: readonly string[],
  pageUrlStyle: PageUrlStyle,
): Promise<Map<string, PublishedVariant[]>> {
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const reg = await refreshLocaleCache(q, ctx);
  const out = new Map<string, PublishedVariant[]>();
  if (reg.byCode.size === 0) return out;
  // #1213 — one render pass asks for the same page's matrix from
  // language_links, head_contributions and the static selector: compute
  // it once per pass, so the switcher and hreflang also read the same rows.
  const byPage = await batchIn<PublishedVariant[] | null>(
    renderMemoOf(ctx),
    `matrix:${pageUrlStyle}`,
  ).getMany(
    pageIds,
    (missing) => computeVariantMatrix(ctx, q, cms, reg, missing, pageUrlStyle),
    null,
  );
  for (const [pageId, variants] of byPage) if (variants) out.set(pageId, variants);
  return out;
}

/**
 * The matrix for `pageIds`, from the variant rows of those pages and of
 * their groups only (#1213): its cost follows the pages asked about, not
 * the site. It used to read every variant row (silently only the first
 * 1000) and every page of the site, on every call.
 */
async function computeVariantMatrix(
  ctx: unknown,
  q: PluginAdminQuery,
  cms: CmsHandle,
  reg: LocaleRegistry,
  pageIds: readonly string[],
  pageUrlStyle: PageUrlStyle,
): Promise<Map<string, PublishedVariant[]>> {
  const out = new Map<string, PublishedVariant[]>();
  const variants = await loadVariantsByPage(q, pageIds, ctx);
  const groupIds = [...new Set([...variants.values()].map((v) => v.group_id))];
  if (groupIds.length === 0) return out;
  const members = await loadGroupMembers(q, groupIds, ctx);
  const statuses = await loadPageStatuses(
    cms,
    [...members.values()].flatMap((group) => group.map((v) => v.page_id)),
    ctx,
  );

  const groups: { groupId: string; published: Omit<PublishedVariant, "href">[] }[] = [];
  for (const groupId of groupIds) {
    const published: Omit<PublishedVariant, "href">[] = [];
    for (const v of members.get(groupId) ?? []) {
      if (statuses.get(v.page_id) !== "published") continue;
      const locale = reg.byCode.get(v.locale_code);
      if (!locale) {
        throw new Error(
          `international-site: variant group ${v.group_id} references unregistered locale "${v.locale_code}"`,
        );
      }
      published.push({
        pageId: v.page_id,
        localeCode: locale.code,
        isDefault: locale.is_default,
        displayName: locale.display_name,
      });
    }
    if (published.length >= 2) groups.push({ groupId, published });
  }
  if (groups.length === 0) return out;

  const urls: Record<string, string> = {};
  const linked = [...new Set(groups.flatMap((g) => g.published.map((v) => v.pageId)))];
  for (const slice of chunked(linked)) {
    const resolved = await cms.call<{ urls: Record<string, string> }>("pages.resolve_public_urls", {
      pageIds: slice,
      pageUrlStyle,
    });
    Object.assign(urls, resolved.urls);
  }
  const byGroup = new Map<string, PublishedVariant[]>();
  for (const group of groups) {
    byGroup.set(
      group.groupId,
      group.published.map((v) => {
        const href = urls[v.pageId];
        if (href === undefined) {
          throw new Error(`international-site: core resolved no public URL for page ${v.pageId}`);
        }
        return { ...v, href };
      }),
    );
  }
  for (const [pageId, v] of variants) {
    const published = byGroup.get(v.group_id);
    if (published) out.set(pageId, published);
  }
  return out;
}

/**
 * Publication status of each page (null = deleted or not visible in this
 * scope), from core's `pages.list_statuses`: the named pages only, one
 * call per 1000, memoised per render pass (#1213).
 */
async function loadPageStatuses(
  cms: CmsHandle,
  pageIds: readonly string[],
  ctx: unknown,
): Promise<Map<string, "draft" | "published" | null>> {
  return batchIn<"draft" | "published" | null>(renderMemoOf(ctx), "pageStatus").getMany(
    pageIds,
    async (missing) => {
      const out = new Map<string, "draft" | "published">();
      for (const slice of chunked(missing)) {
        const { statuses } = await cms.call<{ statuses: Record<string, "draft" | "published"> }>(
          "pages.list_statuses",
          { pageIds: slice },
        );
        for (const [id, status] of Object.entries(statuses)) out.set(id, status);
      }
      return out;
    },
    null,
  );
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
  // The home's counterparts are the same for every page of a pass.
  const roots = await onceIn(renderMemoOf(ctx), "localeRoots", async () => {
    const homePageId = await siteHomePageId(cmsOf(ctx));
    if (!homePageId) return new Set<string>(); // the site has no home page at all
    const homeVariant = (await loadVariantsByPage(q, [homePageId], ctx)).get(homePageId);
    if (!homeVariant) return new Set<string>(); // home is not in any variant group
    const group = (await loadGroupMembers(q, [homeVariant.group_id], ctx)).get(
      homeVariant.group_id,
    );
    // The designated home keeps core's own root handling; only its
    // counterparts need the annotation.
    return new Set((group ?? []).map((v) => v.page_id).filter((id) => id !== homePageId));
  });
  return new Set(pageIds.filter((id) => roots.has(id)));
}

/** #741 — the Power-MCP half of the translation tools' descriptions. */
const MCP_TRANSLATE_PAGE =
  " Over the Power-MCP, when the install's AI is not available to you, it translates nothing itself: it returns a workItem with the exact prompt — translate it with your own model and send the answer back via apply_translations.";
const MCP_TRANSLATE_ALL =
  " Over the Power-MCP, when the install's AI is not available to you, it returns workItems (every stale page plus every language's pending chrome) — translate them yourself and send all answers back in one apply_translations call.";
const MCP_TRANSLATE_CHROME =
  " Over the Power-MCP, when the install's AI is not available to you, it returns a workItem for the language (or says there is nothing to do) — translate it yourself and send the answer back via apply_translations.";
const MCP_REATTACH =
  " Over the Power-MCP, when the install's AI is not available to you, the approved run switches the entry back but does not translate it: then call translate_chrome for that language, translate its workItem yourself and send it back via apply_translations.";

const translateVariantArgs = z
  .object({
    variantPageId: z.string().min(1),
    mode: z.enum(["auto", "full", "update"]).optional(),
  })
  .strict();

/**
 * #741 — translate_all_stale for a delegated call: every needs_update
 * variant and every non-default locale's pending chrome as work items in
 * ONE response, each independently appliable, so the agent can translate
 * them all and answer with a single apply_translations call. No AI call,
 * no write (beyond chrome staleness markers).
 */
async function allStaleWorkItems(
  deps: ChromeDeps,
  stale: readonly PageVariantRow[],
): Promise<{
  workItems: AiWorkItem[];
  pages: number;
  chromeLocales: number;
  failed: Array<{ pageId: string; error: string }>;
  chromeFailed: Array<{ localeCode: string; error: string }>;
  nextStep: string;
}> {
  const workItems: AiWorkItem[] = [];
  const failed: Array<{ pageId: string; error: string }> = [];
  for (const row of stale) {
    try {
      const prepared = await preparePageTranslation(deps, { variantPageId: row.page_id });
      workItems.push(pageWorkItem(prepared, await pageTranslationBasis(prepared)));
    } catch (e) {
      failed.push({ pageId: row.page_id, error: (e as Error).message });
    }
  }
  const pages = workItems.length;
  const chromeFailed: Array<{ localeCode: string; error: string }> = [];
  for (const locale of [...deps.locales.values()].filter((l) => !l.is_default)) {
    try {
      const prepared = await prepareChromeTranslation(deps, { localeCode: locale.code });
      if (prepared.prompt === null) continue;
      workItems.push(chromeWorkItem(prepared, await chromeTranslationBasis(prepared)));
    } catch (e) {
      chromeFailed.push({ localeCode: locale.code, error: (e as Error).message });
    }
  }
  return {
    workItems,
    pages,
    chromeLocales: workItems.length - pages,
    failed,
    chromeFailed,
    nextStep:
      workItems.length === 0
        ? "Nothing to translate: no page variant is stale and every language's chrome is up to date."
        : `Answer every work item's instructions with your own model, then send ALL answers back in ONE ${APPLY_TRANSLATIONS_TOOL} call: one items[] entry per work item (its apply.args.items[0] plus your answer as result).`,
  };
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
      // #1267 — the source content's fingerprint when the variant became
      // up to date, so a rebuild flags exactly the changed sources.
      source_hash: "text",
      // Retired by #1267 (it held a domain-event id): no longer written.
      // Still declared so the previous release's writes succeed during the
      // roll; removed with the domain-event tables (0442's release).
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
    // #592 — a language's version of one piece of shared chrome
    // (`layout:<layoutId>:<block>:<index>` or `instance:<id>`).
    chrome_variants: {
      target_key: "string",
      locale_code: "string",
      mode: "enum:translated,independent",
      module_id: "uuid",
      values: "jsonb",
      translation_status: "enum:up_to_date,needs_update",
      source_hash: "text",
      created_at: "timestamp",
    },
    // Epic #1107 — list translations by value address
    // (`list/<listId>/item/<itemId>/<field>`,
    // `instance/<ciId>/<field>/item/<itemId>/<itemField>`); `value` null =
    // missing. Orphaned rows (address gone) are kept until the removal is
    // live, so an undo restores them.
    list_value_translations: {
      locale_code: "string",
      address: "text",
      value: "text",
      source_hash: "text",
      status: "enum:translated,needs_update,missing,orphaned",
      orphaned_at: "timestamp_nullable",
      created_at: "timestamp",
    },
    // Entries hidden in one language by the operator (address of the entry).
    list_item_visibility: {
      locale_code: "string",
      address: "text",
      hidden: "bool",
      created_at: "timestamp",
    },
    // Vocabulary entries (categories, tags) per language; the slug is
    // unique per list and language (checked on write).
    term_translations: {
      locale_code: "string",
      list_id: "uuid",
      item_id: "uuid",
      name: "text",
      slug: "text",
      source_hash: "text",
      status: "enum:translated,needs_update,missing,orphaned",
      orphaned_at: "timestamp_nullable",
      created_at: "timestamp",
    },
    // Page properties of a language version (source: the group's source page).
    page_prop_translations: {
      locale_code: "string",
      page_id: "uuid",
      field: "string",
      value: "text",
      source_hash: "text",
      status: "enum:translated,needs_update,missing,orphaned",
      orphaned_at: "timestamp_nullable",
      created_at: "timestamp",
    },
  },
  requestedCapabilities: [
    "cms_admin",
    "cms_admin_schema",
    "ai_provider",
    "chat_runner_tools",
    "background_workers",
    "change_journal",
    "head_contributions",
    "content_variants",
    "link_resolve",
    "list_sources",
    "list_resolve",
  ],
  /** Visitor-facing surface (default deny — everything else is
   *  refused a visitor-context dispatch). */
  publicOperations: [],
  /**
   * The language of the page the live editor shows, next to its address:
   * the code as the label, the other versions in the popover (each opens
   * in the editor), the out-of-date ones counted.
   */
  editorToolbar: [
    {
      id: "languages",
      title: "Languages",
      icon: "globe",
      operation: "editor_languages",
      permission: "content.read",
      prompts: [
        {
          label: "Translate this page",
          text: "Translate {page} into every language it is missing or out of date in.",
        },
        { label: "Add a language", text: "Add a new language to the site." },
      ],
    },
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
      const reg = await refreshLocaleCache(q, ctx);
      const annotations: Record<string, Record<string, unknown>> = {};
      if (reg.byCode.size === 0) {
        for (const id of pageIds) annotations[id] = {};
        return { annotations };
      }
      const locales = await localesByPage(q, pageIds, reg.byCode, ctx);
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
      for (const [id, locale] of locales) {
        annotations[id] = {
          locale: locale.code,
          isDefaultLocale: locale.is_default,
          urlStrategy: locale.url_strategy,
          ...(locale.url_host ? { urlHost: locale.url_host } : {}),
          ...(homeVariantIds.has(id) ? { isLocaleRoot: true } : {}),
          // Encode is pure, so the site-wide switch rides per page.
          ...(locale.is_default && reg.prefixDefaultLocale
            ? { [PREFIX_DEFAULT_LOCALE_ANNOTATION]: true }
            : {}),
        };
      }
      return { annotations };
    },

    /**
     * Resolver for the `language_links` list source. Batched over the
     * pages of one render pass, mirroring `head_contributions` — the
     * same published-variant matrix feeds both, so the visible switcher
     * and the hreflang tags can never disagree about what is published.
     * The locale code is the entry id: stable across renders.
     */
    language_links: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const matrix = await publishedVariantMatrix(ctx, pageIds, pageUrlStyleOf(args));
      const sources: Record<
        string,
        Record<string, Array<{ id: string; values: Record<string, unknown> }>>
      > = {};
      for (const pageId of pageIds) {
        const variants = matrix.get(pageId);
        sources[pageId] = {
          // An absent group yields an empty list, not a missing one:
          // "this page has no alternates" is data the module should be
          // allowed to render nothing for.
          language_links: (variants ?? []).map((v) => ({
            id: v.localeCode,
            values: {
              href: { href: v.href },
              label: v.displayName,
              locale: v.localeCode,
              is_current: v.pageId === pageId,
            },
          })),
        };
      }
      return { sources };
    },

    /**
     * Epic #1107 — the list-resolve composition point: per requested
     * language, the translated list values (by address) and the entries
     * hidden there. Read-only; a chat's preview sees the chat's rows.
     */
    list_resolve: async (ctx, args) => {
      const deps = await chromeDepsOf(ctx);
      return resolveListOverlays(deps, args, {
        byPage: (pageIds) => loadVariantsByPage(deps.q, pageIds, ctx),
        groupMembers: (groupIds) => loadGroupMembers(deps.q, groupIds, ctx),
      });
    },

    /** Epic #1107 — hide or show list entries in one language. */
    set_list_item_visibility: async (ctx, args) =>
      setListItemVisibility(await chromeDepsOf(ctx), args),

    /**
     * This plugin's Stage-audit contribution (core's
     * `auditFindingsOperation` hook, docs/quality-checks.md "Plugin
     * contributions"): the first call answers the site rules and the
     * list-translation findings and asks for the facts of every staged
     * page; each fact batch is then checked for hreflang, canonical,
     * language links, page language and untranslated text (./audit.ts).
     * Read-only, main line.
     */
    audit_findings: async (ctx, args) => auditFindings(await chromeDepsOf(ctx), args),

    /**
     * Core's `writeHintsOperation` hook: a module or content write by the
     * AI that hardcodes a link into another language gets a hint in the
     * same tool result (./write-hints.ts). Read-only, the writing chat's
     * scope.
     */
    write_hints: async (ctx, args) => {
      const { writes } = writeHintsArgs.parse(args);
      const q = adminQueryOf(ctx);
      const reg = await refreshLocaleCache(q, ctx);
      if (reg.rows.length < 2) return { hints: [] };
      const variants = (await listAll(q, "page_variants")) as PageVariantRow[];
      return {
        hints: writeHints(
          {
            locales: reg.byCode,
            prefixDefaultLocale: reg.prefixDefaultLocale,
            variants,
            siteHomePageId: await siteHomePageId(cmsOf(ctx)),
          },
          writes as PluginWrite[],
        ),
      };
    },

    /**
     * Epic #1107 — the "Languages" view of one list (or every list): per
     * entry and language, what is translated, stale, missing or hidden.
     * Read-only; the list editor's Languages tab renders it.
     */
    list_translation_status: async (ctx, args) => {
      const { listId } = z
        .object({ listId: z.string().uuid().optional() })
        .strict()
        .parse(args ?? {});
      const deps = await chromeDepsOf(ctx);
      const state = await loadListTranslationState(deps);
      const target = listId ? `list:${listId}` : null;
      return {
        locales: [...deps.locales.values()]
          .filter((l) => !l.is_default)
          .map((l) => ({ code: l.code, displayName: l.display_name })),
        lists: listStatus(deps, state).filter((t) => target === null || t.target === target),
        findings: listFindings(deps, state).filter((f) => target === null || f.target === target),
        hidden: state.visibility
          .filter(
            (r) => r.hidden && (listId === undefined || r.address.startsWith(`list/${listId}/`)),
          )
          .map((r) => ({ localeCode: r.locale_code, address: r.address })),
        // One list: every entry and what it shows in each language.
        ...(target
          ? {
              entries: entryStates(
                state.snapshot,
                target,
                [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code),
                state.index,
                state.linkHasVersion,
                state.hiddenByOperator,
              ),
            }
          : {}),
      };
    },

    /**
     * #592 — the content-variants composition point: core asks, while
     * rendering, which chrome each page shows. Read-only.
     */
    content_variants: async (ctx, args) => {
      const deps = await chromeDepsOf(ctx);
      return resolveChromeVariants(deps, args, (pageIds) =>
        localesByPage(deps.q, pageIds, deps.locales, ctx),
      );
    },

    /**
     * #724 rollout D — the link-resolve composition point: every page's
     * language and variant group, so core resolves internal links to the
     * same-language version of their target. Read-only.
     */
    link_resolve: async (ctx, args) => {
      const { pageIds } = linkResolveArgs.parse(args);
      const q = adminQueryOf(ctx);
      const reg = await refreshLocaleCache(q, ctx);
      return { pages: await pageVariantPartition(q, pageIds, reg.byCode, ctx) };
    },

    /**
     * #724 rollout E — where this plugin stores internal links (the
     * chrome variants' own values), for core's link migration. Read-only.
     */
    link_locations: async (ctx) => chromeLinkLocations(adminQueryOf(ctx), cmsOf(ctx)),

    /**
     * #592 — translate a language's shared chrome in one AI call. #741 —
     * on a delegated call: the same prompt as a work item for the agent.
     */
    translate_chrome: async (ctx, args) => {
      const { localeCode } = z
        .object({ localeCode: z.string().min(2).max(35) })
        .strict()
        .parse(args);
      if (!isAiDelegated(ctx)) {
        return translateChrome(await chromeDepsOf(ctx), aiOf(ctx), { localeCode });
      }
      const prepared = await prepareChromeTranslation(await chromeDepsOf(ctx), { localeCode });
      const counts = {
        upToDate: prepared.upToDate,
        skippedIndependent: prepared.skippedIndependent,
        nothingToTranslate: prepared.nothingToTranslate,
      };
      if (prepared.prompt === null) {
        return {
          translated: 0,
          ...counts,
          nextStep: `Nothing to translate: the ${prepared.locale.display_name} chrome is up to date (independent entries are left alone).`,
        };
      }
      return {
        workItem: chromeWorkItem(prepared, await chromeTranslationBasis(prepared)),
        offered: prepared.offered.length,
        ...counts,
        nextStep: WORK_ITEM_NEXT_STEP,
      };
    },

    /** #592 — give languages their own chrome content (independent mode). */
    set_chrome_variants: async (ctx, args) => setChromeVariants(await chromeDepsOf(ctx), args),

    /**
     * #592 — back to translated mode; runs only after the Owner approved.
     * #741 — delegated: flips the entry, the agent translates it via
     * translate_chrome's work item.
     */
    reattach_chrome_variant: async (ctx, args) =>
      isAiDelegated(ctx)
        ? reattachChromeVariantDelegated(await chromeDepsOf(ctx), args)
        : reattachChromeVariant(await chromeDepsOf(ctx), aiOf(ctx), args),

    /** Worker tick — keeps the decode-side locale cache warm. */
    refresh_locales: async (ctx) => {
      const reg = await refreshLocaleCache(adminQueryOf(ctx), ctx);
      return { locales: reg.rows.length };
    },

    /**
     * #396 — the AI's decision surface (CLAUDE.md §1A): the full
     * translation-state matrix in ONE call, so "is this page
     * translated?" never round-trips to the operator.
     */
    intl_status: async (ctx) => {
      const q = adminQueryOf(ctx);
      const cms = cmsOf(ctx);
      const reg = await refreshLocaleCache(q, ctx);
      const locales = reg.rows;
      const variants = (await listAll(q, "page_variants")) as unknown as PageVariantRow[];
      const pagesResult = await cms.call<{
        pages: { id: string; slug: string; title: string; status: string; currentPath: string }[];
      }>("pages.list", {});
      const pageById = new Map(pagesResult.pages.map((p) => [p.id, p]));
      // Marks the site home, so the AI knows up front that its
      // create_variant takes no slug (every other page needs one).
      const homePageId = await siteHomePageId(cms);
      const homeFlag = (pageId: string) => (pageId === homePageId ? { isSiteHome: true } : {});

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
          ...homeFlag(v.page_id),
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
        // Site-wide: the default locale is prefixed too (home stays at "/").
        prefixDefaultLocale: reg.prefixDefaultLocale,
        groups: [...groups.entries()].map(([groupId, vs]) => ({ groupId, variants: vs })),
        // Pages without a variant row belong to the default locale and
        // have NO translations yet — the AI's to-do surface.
        unassignedPages: pagesResult.pages
          .filter((p) => !linkedPageIds.has(p.id))
          .map((p) => ({
            pageId: p.id,
            slug: p.slug,
            title: p.title,
            path: p.currentPath,
            ...homeFlag(p.id),
          })),
        staleCounts,
        // #592 — the shared chrome (layout header/footer/menus, content
        // synced across pages) and what each language has for it.
        chrome: await chromeStatus(await chromeDepsOf(ctx)),
        // Epic #1107 — lists (menus, footer links, categories, local lists
        // in shared content, page properties of language versions): per
        // list and language how many texts are translated / stale /
        // missing, and what keeps a language from showing them.
        ...(await (async () => {
          const deps = await chromeDepsOf(ctx);
          const state = await loadListTranslationState(deps);
          return { lists: listStatus(deps, state), listFindings: listFindings(deps, state) };
        })()),
      };
    },

    /**
     * The `languages` editor toolbar item: the shown page's language and
     * how its other versions stand (./editor-toolbar.ts). Read-only; it
     * runs on the editor's chat branch, so a version the chat just made
     * shows up at once.
     */
    editor_languages: async (ctx, args) => {
      const { pageId } = z.object({ pageId: z.string().uuid() }).strict().parse(args);
      const q = adminQueryOf(ctx);
      const reg = await refreshLocaleCache(q, ctx);
      const variants = (await listAll(q, "page_variants")) as PageVariantRow[];
      const { pages } = await cmsOf(ctx).call<{ pages: { id: string; status: string }[] }>(
        "pages.list",
        {},
      );
      return languageToolbarState({
        pageId,
        locales: reg.rows,
        variants,
        pages: new Map(pages.map((p) => [p.id, p])),
      });
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
      const reg = await refreshLocaleCache(q, ctx);
      if (!reg.byCode.has(localeCode)) {
        throw new Error(`locale "${localeCode}" is not registered — call set_locales first`);
      }

      // Is the source the site's home? Then its counterpart is the ROOT
      // of its locale (`/de`), and the slug never reaches the URL —
      // which is precisely why the slug must not be the AI's problem
      // here. Slugs went globally unique with #384, so the obvious
      // expression of "this is the German homepage" — reusing the
      // source's own `home` — collides with the English page and leaves
      // the AI improvising renames that cannot succeed either.
      //
      // "Home" is core's verdict, not just the designation: a site whose
      // home is the magic-slug page (`home`, no site_defaults row) serves
      // it at "/" too, and the AI rightly omits the slug for it.
      const homePageId = await siteHomePageId(cms);
      const isLocaleRoot = homePageId === sourcePageId;

      const pages = await cms.call<{
        pages: { id: string; slug: string; currentPath: string; parentPageId: string | null }[];
      }>("pages.list", {});
      const source = pages.pages.find((p) => p.id === sourcePageId);
      const sourceSlug = source?.slug;
      if (!source || !sourceSlug) {
        throw new Error(`source page ${sourcePageId} not found — check intl_status for page ids`);
      }
      // Nested pages (#690): the counterpart sits under the parent's
      // counterpart in the same locale, so /pricing/teams becomes
      // /de/preise/teams — never under the source-language parent.
      let variantParentId: string | null = null;
      if (source.parentPageId !== null) {
        variantParentId = await counterpartInLocale(
          adminQueryOf(ctx),
          source.parentPageId,
          localeCode,
          ctx,
        );
        if (variantParentId === null) {
          const parent = pages.pages.find((p) => p.id === source.parentPageId);
          const parentPath = parent?.currentPath ?? source.parentPageId;
          // The suggested call must itself succeed: it carries a slug
          // unless the parent is the home (whose counterpart takes none).
          const slugArg =
            source.parentPageId === homePageId
              ? ""
              : `, slug: "<${localeCode} slug for '${parent?.slug ?? "the parent"}'>"`;
          throw new Error(
            `create_variant: "${source.currentPath}" sits under ${parentPath}, which has no ${localeCode} counterpart yet. Create that first — create_variant({ sourcePageId: "${source.parentPageId}", localeCode: "${localeCode}"${slugArg} }) — then retry this page; its ${localeCode} version is placed under it.`,
          );
        }
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
          `create_variant: this page is not the site home, so the slug IS its URL segment under /${localeCode}/. Pass a slug — localized ("ueber-uns" for "about") or the same as the source's: URLs only need to differ, and the "/${localeCode}/" prefix already makes them differ.`,
        );
      }
      const newSlug = slug ?? `${sourceSlug}-${localeCode}`;
      const placement = { newParentPageId: variantParentId };

      // The copy exists BEFORE it joins the locale (no prefix yet), so a
      // slug equal to the source's can collide with the source itself.
      // Then the copy is made under a provisional slug and renamed once
      // the locale prefix applies; the draft was never live, so the
      // provisional URL gets no redirect.
      let duplicated: { pageId: string };
      let provisional = false;
      let provisionalSlugUsed = "";
      try {
        duplicated = await cms.call<{ pageId: string }>("pages.duplicate", {
          sourcePageId,
          newSlug,
          ...placement,
          ...(title ? { newTitle: title } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("page already exists at")) throw e;
        provisionalSlugUsed = provisionalSlug(newSlug, localeCode);
        duplicated = await cms.call<{ pageId: string }>("pages.duplicate", {
          sourcePageId,
          newSlug: provisionalSlugUsed,
          ...placement,
          ...(title ? { newTitle: title } : {}),
        });
        provisional = true;
      }

      let linked = await linkPageIntoGroup(ctx, {
        groupPageId: sourcePageId,
        pageId: duplicated.pageId,
        localeCode,
        ...(provisional ? { redirectFromOld: "skip" as const } : {}),
      });
      if (provisional) {
        try {
          await cms.call("pages.update", {
            pageId: duplicated.pageId,
            slug: newSlug,
            redirectFromOld: "skip",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `create_variant: the ${localeCode} variant was created (page ${duplicated.pageId}) under the provisional slug "${provisionalSlugUsed}", but slug "${newSlug}" is taken in that locale: ${msg}. Rename it with update_pages_many to a free slug.`,
          );
        }
        const path = await cms.call<{ path: string }>("pages.refresh_current_path", {
          pageId: duplicated.pageId,
          redirectFromOld: "skip",
        });
        linked = { ...linked, path: path.path };
      }
      return {
        pageId: duplicated.pageId,
        slug: newSlug,
        isLocaleRoot,
        ...linked,
        // #644 — the clone still carries the source language; name the
        // follow-up call with its exact argument so the id is not passed
        // under this result's `pageId` key.
        nextStep: `The variant is a draft still in the source language. Translate it next: translate_variant({ variantPageId: "${duplicated.pageId}" }).`,
      };
    },

    /**
     * Replace the locale registry. APPROVAL-GATED at the tool layer
     * (#388): the SDK pauses for the Owner's in-chat click before this
     * runs. URL moves do NOT happen here — the tool description steers
     * the AI to propose_url_migration afterwards, keeping the two
     * blast radii separately approved.
     */
    set_locales: async (ctx, args) => {
      const { locales, prefixDefaultLocale } = args as {
        locales: Array<{
          code: string;
          displayName: string;
          urlStrategy: "none" | "subdirectory" | "subdomain" | "domain";
          urlHost?: string;
          isDefault: boolean;
        }>;
        prefixDefaultLocale?: boolean;
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
      if (prefixDefaultLocale !== undefined && typeof prefixDefaultLocale !== "boolean") {
        throw new Error(
          `set_locales: prefixDefaultLocale must be true or false (got ${JSON.stringify(prefixDefaultLocale)}); omit it to keep the stored value`,
        );
      }
      const q = adminQueryOf(ctx);
      // Omitted = keep the stored value, so a routine registry edit can
      // never move every default-locale URL by accident.
      const storedSetting = await loadPrefixDefaultLocaleSetting(q);
      const prefixDefault = prefixDefaultLocale ?? storedSetting.enabled;
      const prefixError = prefixDefaultLocaleError(prefixDefault, locales);
      if (prefixError) throw new Error(prefixError);
      const existing = (await q.list("locales", { limit: 500 })) as unknown as LocaleRow[];
      const keep = new Set(locales.map((l) => l.code));
      await assertRemovedLocalesUnused(
        q,
        cmsOf(ctx),
        existing.map((r) => r.code).filter((code) => !keep.has(code)),
      );
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
      if (storedSetting.rowId) {
        await q.update("settings", storedSetting.rowId, { value: { enabled: prefixDefault } });
      } else if (prefixDefault) {
        await q.insert("settings", {
          key: PREFIX_DEFAULT_LOCALE_KEY,
          value: { enabled: prefixDefault },
        });
      }
      let rootRedirect: { fromPath: string; toPath: string } | null = null;
      if (prefixDefault) {
        // The default home serves at "/"; its prefixed address must not
        // be a second, empty root. Upsert, so re-running is idempotent.
        const def = locales.find((l) => l.isDefault);
        if (!def) throw new Error("set_locales: exactly one locale must be isDefault");
        const redirect = defaultLocaleRootRedirect(def.code);
        await cmsOf(ctx).call("redirects.create", redirect);
        rootRedirect = { fromPath: redirect.fromPath, toPath: redirect.toPath };
      }
      await refreshLocaleCache(q, ctx);
      const prefixChanged = prefixDefault !== storedSetting.enabled;
      return {
        locales: locales.length,
        prefixDefaultLocale: prefixDefault,
        ...(rootRedirect ? { rootRedirect } : {}),
        nextStep: prefixChanged
          ? "Locale registry updated and the default-locale prefix setting changed — every default-locale page except the home moves. Call propose_url_migration next; the Owner approves the move (with its 301s) separately."
          : "Locale registry updated. If existing pages' URLs are affected, call propose_url_migration next — the Owner approves the move separately.",
      };
    },

    /**
     * #397 — translate one variant page. ONE context-aware AI call for
     * the whole page (glossary + style guide included); NEVER
     * sentence-by-sentence. Modes: full (fresh clone) / update
     * (source changed after a translation existed) — auto-detected.
     */
    translate_variant: async (ctx, args) => {
      const parsed = translateVariantArgs.parse(args);
      if (isAiDelegated(ctx)) {
        // #741 — the agent translates; nothing is written until it
        // answers through apply_translations.
        const prepared = await preparePageTranslation(await chromeDepsOf(ctx), parsed);
        return {
          workItem: pageWorkItem(prepared, await pageTranslationBasis(prepared)),
          nextStep: WORK_ITEM_NEXT_STEP,
        };
      }
      const ai = aiOf(ctx);
      const result = await translateVariantPage(await chromeDepsOf(ctx), ai, parsed);
      const nextStep = outcomeNextStep(result);
      return nextStep ? { ...result, nextStep } : result;
    },

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
      if (isAiDelegated(ctx)) return allStaleWorkItems(await chromeDepsOf(ctx), stale);
      const deps = await chromeDepsOf(ctx);
      const translated: string[] = [];
      const seoStale: string[] = [];
      const sharedNested: string[] = [];
      const failed: Array<{ pageId: string; error: string }> = [];
      let paused = false;
      for (const row of stale) {
        try {
          const r = await translateVariantPage(deps, aiOf(ctx), { variantPageId: row.page_id });
          translated.push(row.page_id);
          if (r.seo === "marked_stale") seoStale.push(row.page_id);
          if (r.sharedNested)
            sharedNested.push(...r.sharedNested.map((n) => `${row.page_id}: ${n}`));
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
      // #592 — translating the site includes its shared chrome (menus,
      // footer, header): every language's missing or stale chrome, one AI
      // call per language. Independent chrome is left alone.
      let chromeTranslated = 0;
      const chromeFailed: Array<{ localeCode: string; error: string }> = [];
      if (!paused) {
        for (const locale of [...deps.locales.values()].filter((l) => !l.is_default)) {
          try {
            const r = await translateChrome(deps, aiOf(ctx), { localeCode: locale.code });
            chromeTranslated += r.translated;
          } catch (e) {
            const msg = (e as Error).message;
            if (msg.startsWith("PluginAiCapExceeded:")) {
              paused = true;
              break;
            }
            chromeFailed.push({ localeCode: locale.code, error: msg });
          }
        }
      }
      return {
        translated: translated.length,
        failed,
        chromeTranslated,
        chromeFailed,
        paused,
        remaining: stale.length - translated.length - failed.length,
        /** Live variants whose SEO was kept and flagged stale (#591). */
        seoStale,
        /** Nested content left untranslated because another page shares it. */
        sharedNested,
        ...(paused
          ? {
              nextStep:
                "The plugin's 24h AI budget is exhausted. Tell the operator; if they want the cap raised, propose_set_plugin_ai_cost_cap with the amount they name (the Owner approves), then re-run translate_all_stale.",
            }
          : seoStale.length > 0 || sharedNested.length > 0
            ? {
                nextStep: [
                  ...(seoStale.length > 0 ? [SEO_STALE_NEXT_STEP] : []),
                  ...(sharedNested.length > 0
                    ? [`${SHARED_NESTED_NEXT_STEP} Placements: ${sharedNested.join("; ")}.`]
                    : []),
                ].join(" "),
              }
            : {}),
      };
    },

    /**
     * #741 — write an agent's answers to translation work items. Never
     * calls ctx.ai, so it serves delegated and install-side callers alike.
     */
    apply_translations: async (ctx, args) => applyTranslations(await chromeDepsOf(ctx), args),

    /** #397 — upsert a glossary term for a target locale. */
    set_glossary_term: async (ctx, args) => {
      const { term, localeCode, translation, context } = args as {
        term: string;
        localeCode: string;
        translation: string;
        context?: string;
      };
      const q = adminQueryOf(ctx);
      const reg = await refreshLocaleCache(q, ctx);
      if (!reg.byCode.has(localeCode)) {
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
      const reg = await refreshLocaleCache(q, ctx);
      if (!reg.byCode.has(localeCode)) {
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
     * consume collectContributions). Every requested page — grouped or
     * not — also gets its locale as the document language (`<html
     * lang>`), so a German variant is announced as German even though
     * the site's stored language is the default locale's.
     */
    head_contributions: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const q = adminQueryOf(ctx);
      const reg = await refreshLocaleCache(q, ctx);
      const matrix = await publishedVariantMatrix(ctx, pageIds, pageUrlStyleOf(args));
      const lang: Record<string, string> = {};
      for (const [pageId, locale] of await localesByPage(q, pageIds, reg.byCode, ctx)) {
        lang[pageId] = locale.code;
      }
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
      return { head, sitemap, lang };
    },

    /**
     * The change consumer (#397, on the change journal since #1267): the
     * host hands it committed changes of the MAIN line — a chat's change
     * arrives when its Stage lands it there, which is when staleness
     * starts. Marks the sibling variants of changed SOURCE pages
     * needs_update, re-derives chrome staleness when a module or a shared
     * content instance changed, and the list translations' statuses from
     * the main line on any change. At-least-once delivery is safe: every
     * mark is idempotent.
     */
    translation_staleness_tick: async (ctx, args) => {
      const { changes } = stalenessChangesArgs.parse(args);
      if (changes.length === 0) return { marked: 0, scanned: 0 };
      const cms = cmsOf(ctx);
      const sourcePageIds = new Set<string>();
      const instanceIds = new Set<string>();
      // #592 — a live edit of a module (layout chrome renders its field
      // defaults) or of a shared content instance may change chrome a
      // translated locale variant was derived from.
      let chromeTouched = false;
      for (const c of changes) {
        if (c.op === "truncate") continue;
        switch (c.kind) {
          case "module":
            chromeTouched = true;
            break;
          case "content_instance":
            chromeTouched = true;
            instanceIds.add(c.rowId);
            break;
          case "page":
          case "page_layout":
          case "page_seo":
            if (c.op !== "delete") sourcePageIds.add(c.rowId);
            break;
          case "page_module_content":
            if (c.parentId) sourcePageIds.add(c.parentId);
            break;
          // Lists, list types, page types and terms are the list
          // reconciliation's (below); a page's own staleness is its content.
          default:
            break;
        }
      }
      // A value edit on a (possibly shared) instance is a content change on
      // EVERY page it renders on (#627: its parents' pages included).
      for (const id of instanceIds) {
        const got = await cms
          .call<{ renderedOn: { pageId: string }[] }>("content_instances.get", { id })
          .catch((e: unknown) => {
            // A deleted instance has no pages left to render on; its
            // placements changed with it and arrive as page changes.
            if (e instanceof Error && /not found|NotFound/i.test(e.message)) return null;
            throw e;
          });
        for (const p of got?.renderedOn ?? []) sourcePageIds.add(p.pageId);
      }
      const deps = await chromeDepsOf(ctx);
      let marked = await markSiblingsStale(deps, sourcePageIds);
      if (chromeTouched) marked += await refreshChromeStaleness(deps);
      const lists = await reconcileListTranslations(deps, await lastLiveBuildAt(deps));
      return { marked, scanned: changes.length, lists };
    },

    /**
     * The change consumer's rebuild (#1267): runs on first activation and
     * when the plugin's journal cursor fell behind the journal's horizon
     * (its consumer stalled for a week, or the plugin was deactivated in
     * between). Every status is recomputed from stored source
     * fingerprints, exactly: an up-to-date page variant is flagged
     * needs_update only when its group source's content differs from the
     * `source_hash` it was translated from (or that the backfill adopted).
     * A variant with no hash has no basis to compare and is flagged; one
     * whose source is gone (none, or deleted) is left as it is.
     */
    rebuild_translation_staleness: async (ctx) => {
      const deps = await chromeDepsOf(ctx);
      const { q } = deps;
      let marked = 0;
      const sourceHashOf = sourceHashesOf(deps);
      for (let afterId: string | undefined; ; ) {
        const rows = (await q.list("page_variants", {
          translation_status: "up_to_date",
          orderBy: "id",
          limit: 1000,
          ...(afterId ? { afterId } : {}),
        })) as unknown as PageVariantRow[];
        for (const row of rows) {
          const current = await sourceHashOf(row.group_id);
          // No source to compare with (none, or deleted): left as it is.
          if (current === null || storedFingerprint(row.source_hash) === current) continue;
          await q.update("page_variants", row.id, { translation_status: "needs_update" });
          marked += 1;
        }
        if (rows.length < 1000) break;
        afterId = rows.at(-1)?.id;
      }
      marked += await refreshChromeStaleness(deps);
      const lists = await reconcileListTranslations(deps, await lastLiveBuildAt(deps));
      return { marked, lists };
    },
  },
  /**
   * #1267 — backfill the source fingerprints of variants translated before
   * the change journal ({@link backfillSourceHashes}); a no-op once done.
   */
  onActivate: async (ctx) => {
    await backfillSourceHashes(ctx);
  },
  /**
   * Translation staleness from the change journal (#397, #1267): live
   * changes only — a chat's change counts once its Stage lands it.
   */
  changeConsumer: {
    operationName: "translation_staleness_tick",
    rebuildOperationName: "rebuild_translation_staleness",
    kinds: [
      "page",
      "page_layout",
      "page_seo",
      "page_module_content",
      "page_terms",
      "page_type",
      "module",
      "content_instance",
      "list",
      "list_type",
    ],
    lines: "main",
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
        "Fetch the FULL translation state in one call: registered locales (code, strategy, default flag), every variant group (which pages are language-counterparts of each other, with per-variant translation status and current path), pages not yet in any group (they belong to the default locale and have no translations), per-locale stale counts, the shared chrome, and the lists (`lists`: per list and language translated / needs_update / missing counts; `listFindings`: texts missing and entries hidden because their link has no version in a language, each with its next step). The site home carries `isSiteHome: true` (its create_variant takes no slug). " +
        "Call this FIRST for any i18n question ('is X translated?', 'what is missing in German?') — never ask the operator. " +
        "NOT for changing anything: use create_variant / link_page_variants / set_locales to act.",
      operationName: "intl_status",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "create_variant",
      description:
        "Create the language counterpart of a page: duplicates the source page as a DRAFT, joins it into the source's variant group, and composes its URL (e.g. /de/<slug>). " +
        "The slug is freely localizable ('preise' for 'pricing') or may equal the source's ('about' → /de/about) — URLs must differ, slugs need not; linkage is by group, never by slug. " +
        "Nested pages: the variant is placed under the SAME-LOCALE counterpart of the source's parent (/pricing/teams → /de/preise/teams). If that parent has no counterpart yet, the call fails naming it — create_variant the parent first. " +
        "`slug` is REQUIRED for every page except the site's HOME page (the one intl_status marks `isSiteHome: true`, served at '/'): OMIT it there — the home's counterpart is the root of its locale ('/de'), carries no URL segment, and gets a derived slug automatically. Passing one for the home, or omitting it for any other page, is an error. " +
        "Use when a page has no variant in the target locale yet (check intl_status). The draft still carries the SOURCE language — run the translation flow next, then publish. " +
        "NOT for linking two ALREADY-EXISTING pages — that is link_page_variants.",
      operationName: "create_variant",
      // Writes content on the chat's branch: the operator needs content.write,
      // as for editing the page in the editor.
      requiredPermission: "content.write",
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
              "Localized URL segment under /<locale>/ ('preise' for 'pricing'). REQUIRED for every page except the site home (intl_status `isSiteHome: true`); MUST be omitted for the home.",
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
      // Content write on the chat's branch.
      requiredPermission: "content.write",
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
      // Content write on the chat's branch.
      requiredPermission: "content.write",
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
        "Changing locales does NOT move existing pages by itself: when URLs are affected, call propose_url_migration afterwards (a separately approved step with its own blast-radius preview). " +
        "prefixDefaultLocale (optional, site-wide): true prefixes the DEFAULT locale too (/de/preise next to /en/pricing) while the default home stays at '/' with no redirect, and '/<default code>' 301s to '/'. Needs the default locale on the subdirectory strategy. Omit it to keep the current value; set it only when the operator asks for every language to carry its prefix.",
      operationName: "set_locales",
      approvalMode: "user-approval",
      // #589 — the approver changes site-wide language and URL settings.
      requiredPermission: "settings.write",
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
          prefixDefaultLocale: {
            type: "boolean",
            description:
              "Prefix the default locale too (home stays at '/'). Omit to keep the current setting.",
          },
        },
      },
    },
    {
      name: "translate_variant",
      description:
        "Translate ONE variant page from its group's source language — the whole page in a single context-aware pass (module layout locked; glossary + style guide applied; existing human-polished translations preserved where the source did not change). " +
        "Use after create_variant (the draft still carries the source language) and for any variant intl_status marks needs_update. The result stays a DRAFT — review, then publish. " +
        'The meta description is translated in the same pass: a draft or a variant without one gets it filled; a LIVE variant that already has one keeps it (SEO fill-once) and comes back seo: "marked_stale" with a nextStep — then re-optimize with bulk_optimize_seo only if the operator wants it. ' +
        "NOT for many pages at once — prefer translate_all_stale. NOT for the group's source page itself." +
        MCP_TRANSLATE_PAGE,
      operationName: "translate_variant",
      usesInstallAi: true,
      // Content write on the chat's branch.
      requiredPermission: "content.write",
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
        "If the plugin's 24h AI budget runs out mid-pass, the result carries paused=true + remaining — tell the operator instead of retrying; if they want the cap raised, propose_set_plugin_ai_cost_cap with the amount they name." +
        MCP_TRANSLATE_ALL,
      operationName: "translate_all_stale",
      usesInstallAi: true,
      // Content write on the chat's branch.
      requiredPermission: "content.write",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "translate_chrome",
      description:
        "Translate the site's shared CHROME and LISTS into one language — navigation menus, header, footer, content shared across pages, every list (menus, footer links, categories, tags, local lists in shared content) and the page properties of that language's pages — in ONE context-aware pass, so every page in that language shows its own menus and labels. " +
        "List texts are offered by value address (list/<listId>/item/<itemId>/<field>, instance/…, page/<pageId>/props/<field>) and stored by it; only texts that are missing or whose source changed are offered. Until a list entry's required text is translated, that entry is HIDDEN on the language's pages (never shown in the source language). " +
        "Use when a language is added, when intl_status lists chrome entries as 'missing'/'translated/needs_update' or lists with missing/needs_update counts, or when the preview flags 'there is no <language> version of …'. Links inside menus need no work: they point at each page's same-language version automatically (an entry whose link has no version in the language is hidden and listed in intl_status.listFindings). " +
        'Chrome a language runs independently (its own items) is never overwritten. translate_all_stale already includes this for every language — prefer it when pages are stale too. For one wording the operator dictates, use apply_translations with kind "addresses" instead.' +
        MCP_TRANSLATE_CHROME,
      operationName: "translate_chrome",
      usesInstallAi: true,
      // Content write on the chat's branch.
      requiredPermission: "content.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["localeCode"],
        properties: { localeCode: { type: "string", minLength: 2, maxLength: 35 } },
      },
    },
    {
      name: "set_chrome_variants",
      description:
        "Give a language its OWN chrome instead of a translation of the default language's: different menu items, links or number of entries (values), or — for a layout area like the header or footer — a different module (moduleId). The entry becomes independent: later edits to the default language never touch or flag it. " +
        "Use when the operator wants e.g. the English menu to differ ('the US site has no Careers link', 'use the other footer on the German site'). Omit values to just detach the current translation. targetKey comes from intl_status.chrome. Prefer one call with several entries over repeated calls. " +
        "NOT for plain translation (translate_chrome) and NOT for the default language (edit the layout/content directly).",
      operationName: "set_chrome_variants",
      // Content write on the chat's branch.
      requiredPermission: "content.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["variants"],
        properties: {
          variants: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["targetKey", "localeCode"],
              properties: {
                targetKey: { type: "string" },
                localeCode: { type: "string", minLength: 2, maxLength: 35 },
                values: { type: "object" },
                moduleId: { type: "string", format: "uuid" },
              },
            },
          },
        },
      },
    },
    {
      name: "reattach_chrome_variant",
      description:
        "Switch a language's independent chrome entry back to 'translated': its own content (and own module) is REPLACED by a fresh translation of the default language's, and from then on edits to the source mark it stale again. " +
        "APPROVAL-GATED because it overwrites the language's own content: the turn pauses on an in-chat card and the operator clicks Approve — say 'I prepared switching the <language> menu back to the translated version — please approve' and do NOT claim it is done." +
        MCP_REATTACH,
      operationName: "reattach_chrome_variant",
      usesInstallAi: true,
      approvalMode: "user-approval",
      requiredPermission: "content.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["targetKey", "localeCode"],
        properties: {
          targetKey: { type: "string" },
          localeCode: { type: "string", minLength: 2, maxLength: 35 },
        },
      },
    },
    {
      name: APPLY_TRANSLATIONS_TOOL,
      description:
        "Write translations back. (1) The answers to work items that translate_variant, translate_all_stale and translate_chrome return over the Power-MCP when the install's AI is not available to you: each items[] entry is a work item's apply.args.items[0] copied unchanged (kind, variantPageId + mode or localeCode, basis) plus `result`: your answer to that item's instructions — the JSON object they ask for (or its text). " +
        "(2) List texts by ADDRESS, no work item needed: { kind: \"addresses\", localeCode, translations: [{ address, value }] } — use it when the operator dictates a wording ('in German the menu says Preise') or to fix one translated list text; addresses come from intl_status.lists / list_translation_status / translate_chrome (list/<listId>/item/<itemId>/<field>, instance/<ciId>/<field>/item/<itemId>/<itemField>, page/<pageId>/props/<field>). A category/tag slug must be unique per list and language. " +
        "Send every answer you have in ONE call (up to 100 items). All items are checked first — JSON contract, structural lock, and that the page/chrome did not change since the work item was issued (basis); if any item fails, NOTHING is written and the error lists every failing item with what to do (fix the answer, or fetch a fresh work item). " +
        'Applied pages stay DRAFTS; a result with seo "marked_stale" carries a nextStep. ' +
        "NOT for translating yourself without a work item — call translate_variant / translate_chrome first; the basis must come from them.",
      operationName: APPLY_TRANSLATIONS_TOOL,
      // Content write on the chat's branch, like translate_variant.
      requiredPermission: "content.write",
      inputJsonSchema: applyTranslationsInputJsonSchema,
    },
    {
      name: "set_list_item_visibility",
      description:
        "Hide list entries in ONE language (or show them again): 'the German menu has no Careers link', 'drop the US-only tag on the French site'. The entry stays in the list and in every other language; nothing is deleted. " +
        "address is the ENTRY address — list/<listId>/item/<itemId> for a shared list, instance/<ciId>/<field>/item/<itemId> for a local list (intl_status.lists, list_translation_status and intl_status.listFindings name them). hidden: false removes your decision again (the entry then follows the normal rules: hidden only while its required text is untranslated or its link has no version in the language). " +
        'Prefer one call with every entry over repeated calls. NOT for the default language — remove the entry from the list itself (patch_list_items_many) — and NOT for changing a wording (apply_translations with kind "addresses").',
      operationName: "set_list_item_visibility",
      // Content write on the chat's branch.
      requiredPermission: "content.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["localeCode", "address", "hidden"],
              properties: {
                localeCode: { type: "string", minLength: 2, maxLength: 35 },
                address: { type: "string", minLength: 1, maxLength: 400 },
                hidden: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    {
      name: "list_translation_status",
      description:
        "The Languages view of the site's lists in one call: per list (or local list / page) and language how many texts are translated, need an update (source changed) or are missing, which entries the operator hid per language, and the findings (texts missing, entries hidden because their link target has no version in that language). Pass listId for one list. " +
        "Use for 'is the German menu translated?', 'why does the French footer miss an entry?'. NOT for translating (translate_chrome) or hiding (set_list_item_visibility); intl_status carries the same summary next to pages and chrome.",
      operationName: "list_translation_status",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { listId: { type: "string", format: "uuid" } },
      },
    },
    {
      name: "set_glossary_term",
      description:
        "Pin the exact translation of a term for a target locale (e.g. 'checkout' → 'Kasse' for de). Every future translation into that locale uses it verbatim. " +
        "Use when the operator corrects a translated word or names brand/product terminology ('never translate our product name'). One call per term+locale; re-calling updates the entry.",
      operationName: "set_glossary_term",
      // Content write on the chat's branch.
      requiredPermission: "content.write",
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
      // Content write on the chat's branch.
      requiredPermission: "content.write",
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
  staticRender: async (ctx, { pageId, pageUrlStyle }) => {
    const matrix = await publishedVariantMatrix(ctx, [pageId], pageUrlStyle);
    const variants = matrix.get(pageId);
    if (!variants) return "";
    const items = variants
      .map((v) => {
        const label = escapeHtml(v.displayName || v.localeCode);
        const current = v.pageId === pageId ? ' aria-current="page"' : "";
        return `<li><a href="${escapeHtml(v.href)}" hreflang="${escapeHtml(v.localeCode)}"${current}>${label}</a></li>`;
      })
      .join("");
    return `<nav class="caelo-language-selector" aria-label="Language"><ul>${items}</ul></nav>`;
  },
  contributes: ["head", "sitemap"],
  /**
   * The visible counterpart to the hreflang links: the same published
   * variants, as DATA for a module to iterate. `staticRender` above
   * still ships a ready-made switcher for operators who want one
   * without authoring markup, but a module using this source carries the
   * site's own design and — because it resolves per page — can live in
   * the LAYOUT and cover every page from one placement.
   */
  listSources: [
    {
      name: "language_links",
      label: "Language versions of this page",
      description:
        "Every PUBLISHED language version of the current page, including the current one. Empty when the page has fewer than two published variants — a lone language needs no switcher.",
      node: {
        label: "Language version",
        fields: [
          { name: "href", label: "Address", type: "link", required: true },
          { name: "label", label: "Language name", type: "text", required: true },
          { name: "locale", label: "Language code", type: "text", required: true, maxLength: 35 },
          { name: "is_current", label: "Is this page", type: "boolean" },
        ],
      },
    },
  ],
  listSourcesOperation: "language_links",
  /**
   * Epic #1107 — the `translate` attribute on list-type fields and page
   * properties (`ext["international-site"].translate`). Core validates
   * it against this schema and never reads it.
   */
  listExt: { field: LIST_EXT_FIELD_SCHEMA },
  listResolveOperation: "list_resolve",
  auditFindingsOperation: "audit_findings",
  writeHintsOperation: "write_hints",
  contributionsOperation: "head_contributions",
  contentVariantsOperation: "content_variants",
  linkResolveOperation: "link_resolve",
  linkLocationsOperation: "link_locations",
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
        "2. If the target-language counterpart does not exist yet: create_variant with a LOCALIZED slug ('preise' for 'pricing', not 'pricing-de'). For the site's HOME page (intl_status marks it `isSiteHome: true`) omit the slug entirely — its counterpart is the locale root ('/de') and has no URL segment; every other page needs a slug. The draft still carries the source language.",
        "3. Call translate_variant on the counterpart. It translates the WHOLE page in one context-aware pass — title, every content field, the texts modules show from their field defaults (buttons, form labels, menu entries), the page's own lists and nested content — honouring the site glossary and style guide. Never translate field-by-field yourself, and never edit shared module HTML to translate it: module code is shared across pages, content lives in per-page values. If the result names nested content shared with another page, fork_placement_content on that placement and translate again.",
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
        "2. Call set_locales with the FULL desired list (existing locales + the new one; exactly one isDefault). The turn pauses for the Owner's in-chat Approve. Pick the URL strategy from what the operator wants: subdirectory (/de/...) is the safe default; subdomain/domain need urlHost. The default locale serves bare (/preise) unless the operator wants EVERY language prefixed (/de/preise + /en/pricing): then pass prefixDefaultLocale: true — the default home stays at '/' (no redirect) and '/<default code>' 301s to it.",
        "3. If existing pages' URLs are affected by the change, call propose_url_migration next — it previews the URL fan-out and the 301 redirects, and the Owner approves it SEPARATELY.",
        "4. Seed the language: for each core page the operator cares about, create_variant with a localized slug (omit the slug for the home page — its counterpart is the locale root), then translate_variant. Do not mass-create variants for every page unprompted — ask which pages matter, or start with the pages the operator named.",
        "5. hreflang links and sitemap alternates appear automatically once variants are PUBLISHED (drafts are invisible to search engines by design — a missing translation is a clean 404, never a fallback).",
        "5b. Translate the shared chrome too — menus, header, footer and content shared across pages: call translate_chrome({localeCode}) once per new language (translate_all_stale also covers it). Until then the preview flags 'there is no <language> version of …' and publishing refuses: pages never fall back to another language. Menu links need no work — they point at each page's same-language version, and a link whose target has no version in that language is flagged. If the operator wants a language's menu or footer to DIFFER (other items, another footer module), use set_chrome_variants; switching it back to the translated version is reattach_chrome_variant (approval-gated, it overwrites).",
        "5c. Lists follow the language automatically by address: translate_chrome also translates every list (menus, footer links, categories and tags with their slugs, local lists in shared content) and the page properties of the language's pages. A list entry whose required text is not translated yet is HIDDEN on that language's pages — never shown in the source language — and so is an entry whose link points at a page without a version in that language (intl_status.listFindings names them: create the page's variant, or hide the entry on purpose with set_list_item_visibility). For a wording the operator dictates, apply_translations with kind \"addresses\".",
        '5d. Which list fields are translated: text and rich text, unless the list type marks the field `ext: { "international-site": { translate: false } }` (SKUs, codes, brand names). When you create or change a list type with upsert_list_types_many, set that attribute in the same call for every text field whose value is the same in every language; leave it out (= translated) otherwise. Turning it off keeps existing translations but stops applying them; turning it on makes the texts "missing" until translated.',
        '6. To offer visitors a language switcher, add a module whose HTML iterates the plugin\'s list source: `<nav>{{#language_links}}<a href="{{href}}" hreflang="{{locale}}"{{#is_current}} aria-current="page"{{/is_current}}>{{label}}</a>{{/language_links}}</nav>`. Each entry carries href (a link), label, locale and is_current (a boolean). Write the markup to match the site\'s design — you own it, the plugin only supplies the data. Because it resolves per page, placing that module in the LAYOUT gives every page a switcher from one placement. The list is empty until a page has at least two PUBLISHED variants.',
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
      slug: "international-qa",
      displayName: "Fix language findings",
      description:
        "How to fix the international-site findings of a Stage audit (plugin.international-site/…): language links, hreflang, page language and untranslated text.",
      body: [
        "You are fixing the language findings of a Stage audit on a multilingual Caelo site (rules plugin.international-site/<rule>). Every error blocks Publish live; warnings are fixed too — the target is a report without findings, never 'good enough'. Fix, Stage again, and repeat until nothing is left. What you cannot fix goes to the operator as one decision (they can accept a finding per rule in the audit).",
        "",
        "Language links:",
        '- hardcoded-language-link / switcher-to-home: a language switch built from fixed links. Replace it in the named module (update_modules_many) with the language_links list source: `<nav>{{#language_links}}<a href="{{href}}" hreflang="{{locale}}"{{#is_current}} aria-current="page"{{/is_current}}>{{label}}</a>{{/language_links}}</nav>`. It lists exactly the published versions of the current page, so it never leads to a 404. Never link another language\'s page by a page link either: page links follow the language of the page they are on.',
        "- switcher-missing: place such a module in the layout (add_module, target layout) — one placement covers every page.",
        "- cross-locale-content-link: link the page itself, not the literal path of another language's page.",
        "",
        "hreflang, canonical, sitemap (the plugin writes them from the language groups):",
        "- hreflang-self-missing / hreflang-missing-version / hreflang-not-reciprocal / hreflang-target-broken: the language group is wrong or a version is not published. Check intl_status; relink with link_page_variants, unlink a wrong page with unlink_page_variants, or publish the missing version.",
        "- hreflang-target-not-indexable / canonical-cross-locale: a version has noindex or a canonical override pointing elsewhere. Every language version is indexable and canonical to itself (set_page_seo_many).",
        "- hreflang-invalid-code: fix the language codes with set_locales (approval-gated; en-GB, not en-UK).",
        "- sitemap-alternates-mismatch: a Caelo bug — report it with bug_report.",
        "",
        "Page language and text:",
        "- html-lang-mismatch: the page is in the wrong language group, or not in one; fix the group (link_page_variants).",
        "- content-wrong-language / content-mixed-language / alt-untranslated / seo-untranslated: run translate_variant on the version. It translates every placement, the texts modules show from their field defaults (buttons, form labels, menu entries) and nested content. If its result says nested content is shared with another page, fork_placement_content on that placement first, then translate again. A brand or product name that is the same in every language belongs in the glossary with itself as the translation (set_glossary_term) — then it is no finding.",
        "- chrome-untranslated / chrome-translation-stale: translate_chrome for that language.",
        "- translation-stale: one translate_all_stale call.",
        "- glossary-violation: translate_variant again (the glossary is part of every call).",
        "- locale-empty / locale-home-missing: create and translate the language's pages, home page first (create_variant without slug for the home), or remove the language with set_locales.",
        "- variant-group-broken: intl_status shows the group; unlink the page that does not belong.",
        "- locale-format, slug-untranslated, og-locale-mismatch, coverage: hints. Fix them when the operator wants the page fully localized (skill localize-slugs for slugs).",
      ].join("\n"),
      autoEngagementHints: {
        keywords: [
          "international-site",
          "hreflang",
          "language switch",
          "sprachwechsel",
          "language link",
          "untranslated",
          "nicht übersetzt",
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
      encode: (page) => encodeLocalePrefix(page),
      decode: (segments) => decodeLocalePrefix(segments, localeCache, prefixDefaultLocaleCache),
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
