// SPDX-License-Identifier: MPL-2.0

/**
 * The international-site plugin's own checks of a staged build — the
 * pure half (the I/O lives in ./audit.ts).
 *
 * Core does not know what a language version is (epic #380): it sees a
 * link to `/en/` as a path and reports it only when nothing answers
 * there. Which link is a LANGUAGE link, which page it should lead to on
 * each page, whether hreflang, canonical and sitemap agree, and whether a
 * page labelled English actually shows English — only this plugin knows.
 *
 * Two kinds of rules:
 *  - site rules from the plugin's data alone (stale translations, empty
 *    languages, broken variant groups, coverage), answered on the first
 *    call;
 *  - page rules from the facts core extracted from the rendered pages
 *    (`PluginAuditPageFacts`), answered per fact batch. A batch holds
 *    whole variant groups, so a page is always checked next to its
 *    language versions.
 *
 * One defect, one finding: what core's `links` / `references` checks
 * report (a 404, a stored link to a missing version) is not repeated
 * here; these rules name the language cause. A finding about shared
 * markup (a module, the page template) names no page and reads the same
 * on every page, so core files it once however many batches see it.
 *
 * Severity (concept 2026-10-26): `error` when a visitor or a search
 * engine gets something broken or wrong, `warning` when the page works
 * but is worse than it should be, `info` for what can be a deliberate
 * choice. A missing translation is never an error: it is a clean 404 by
 * design (CLAUDE.md §2).
 */

import type { PluginAuditFinding, PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import type { LocaleRow, PageVariantRow } from "./index.js";
import type { GlossaryRow } from "./page-translation.js";

/** A page of the staged build. */
export interface StagedPageRef {
  readonly pageId: string;
  readonly path: string;
}

/** A stale shared-content translation (header, footer, menu). */
export interface StaleChrome {
  readonly label: string;
  readonly localeCode: string;
}

/** Everything the rules read besides the page facts. */
export interface AuditState {
  readonly locales: ReadonlyMap<string, LocaleRow>;
  readonly variants: readonly PageVariantRow[];
  readonly stagedPages: readonly StagedPageRef[];
  /** The page core serves at `/` (its group holds every language's home). */
  readonly siteHomePageId: string | null;
  readonly glossary: readonly GlossaryRow[];
  /** Modules placed in a layout: their text is the site's chrome. */
  readonly chromeModuleIds: ReadonlySet<string>;
  readonly staleChrome: readonly StaleChrome[];
}

/** Pages per fact batch (whole groups are never split). */
export const FACT_BATCH_PAGES = 100;

/** Most examples quoted in one message. */
const MAX_EXAMPLES = 4;

/** Below this many characters of page text the language share is not judged. */
const MIN_TEXT_FOR_LANGUAGE = 200;

/** Share of a version's text identical to the source's that makes it "the wrong language". */
const WRONG_LANGUAGE_SHARE = 0.5;

/** Region subtags people write that are not ISO 3166 codes. */
const WRONG_REGIONS: Readonly<Record<string, string>> = { UK: "GB" };

// ---------------------------------------------------------------------------
// The derived view: locale, group and language versions of every page.
// ---------------------------------------------------------------------------

/** The plugin's model of the staged build. */
export class BuildModel {
  readonly defaultLocale: LocaleRow;
  readonly pathOf = new Map<string, string>();
  readonly pageAt = new Map<string, string>();
  readonly variantOf = new Map<string, PageVariantRow>();
  readonly membersOf = new Map<string, PageVariantRow[]>();
  /** {@link languageNames} per locale code, computed once per model. */
  readonly languageNameCache = new Map<string, ReadonlySet<string>>();

  constructor(readonly state: AuditState) {
    const def = [...state.locales.values()].find((l) => l.is_default);
    if (!def) {
      throw new Error(
        "international-site audit: no default language is registered — call set_locales",
      );
    }
    this.defaultLocale = def;
    for (const p of state.stagedPages) {
      this.pathOf.set(p.pageId, p.path);
      this.pageAt.set(p.path, p.pageId);
    }
    for (const v of state.variants) {
      if (!state.locales.has(v.locale_code)) continue;
      this.variantOf.set(v.page_id, v);
      const list = this.membersOf.get(v.group_id) ?? [];
      list.push(v);
      this.membersOf.set(v.group_id, list);
    }
  }

  /** The language of a page: its variant row's, else the default (ungrouped pages). */
  localeOf(pageId: string): string {
    return this.variantOf.get(pageId)?.locale_code ?? this.defaultLocale.code;
  }

  /** The PUBLISHED language versions of a page, itself included, by locale. */
  versionsOf(pageId: string): Map<string, string> {
    const v = this.variantOf.get(pageId);
    const out = new Map<string, string>();
    if (!v) {
      if (this.pathOf.has(pageId)) out.set(this.defaultLocale.code, pageId);
      return out;
    }
    for (const m of this.membersOf.get(v.group_id) ?? []) {
      if (this.pathOf.has(m.page_id)) out.set(m.locale_code, m.page_id);
    }
    return out;
  }

  /** The group's source page, when it is published. */
  sourceOf(pageId: string): string | null {
    const v = this.variantOf.get(pageId);
    if (!v) return null;
    const src = (this.membersOf.get(v.group_id) ?? []).find(
      (m) => m.translation_status === "source",
    );
    return src && this.pathOf.has(src.page_id) ? src.page_id : null;
  }

  /** Every language's published home page, by locale. */
  homes(): Map<string, string> {
    return this.state.siteHomePageId ? this.versionsOf(this.state.siteHomePageId) : new Map();
  }

  /**
   * The language a site path belongs to: the page's there, else a locale
   * prefix (`/en/...`) — a link to a version that does not exist still
   * names its language.
   */
  localeOfPath(path: string): string | null {
    const page = this.pageAt.get(path);
    if (page) return this.localeOf(page);
    const first = path.split("/")[1]?.toLowerCase();
    if (!first) return null;
    for (const l of this.state.locales.values()) {
      if (l.code.toLowerCase() === first) return l.code;
    }
    return null;
  }

  displayName(code: string): string {
    return this.state.locales.get(code)?.display_name ?? code;
  }
}

/** The primary language subtag, lower-case (`de-AT` → `de`, `de_DE` → `de`). */
function primary(tag: string): string {
  return tag.replace(/_/g, "-").split("-")[0]?.toLowerCase() ?? "";
}

/** Does `tag` name `locale` (exact for a regional locale, by primary subtag otherwise)? */
function sameLanguage(tag: string, locale: string): boolean {
  const t = tag.replace(/_/g, "-").toLowerCase();
  const l = locale.toLowerCase();
  return l.includes("-") ? t === l : primary(t) === l;
}

/**
 * Names a visitor could see for `code` on a language link: the code, the
 * registered display name, and the language's name in each registered
 * language (`English`, `Englisch`, `anglais`).
 */
export function languageNames(code: string, model: BuildModel): ReadonlySet<string> {
  const cached = model.languageNameCache.get(code);
  if (cached) return cached;
  const names = new Set<string>([code.toLowerCase(), model.displayName(code).toLowerCase()]);
  for (const l of model.state.locales.values()) {
    try {
      const name = new Intl.DisplayNames([l.code], { type: "language" }).of(code);
      if (name) names.add(name.toLowerCase());
    } catch {
      // A code Intl does not know still matches by its code and display name.
    }
  }
  model.languageNameCache.set(code, names);
  return names;
}

function quote(s: string, max = 60): string {
  return `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
}

function whereOf(moduleId: string | null, pluginSlug: string | null): string {
  if (moduleId) return `module ${moduleId}`;
  if (pluginSlug) return `the output of plugin ${pluginSlug}`;
  return "the page template";
}

// ---------------------------------------------------------------------------
// Site rules (first call).
// ---------------------------------------------------------------------------

/** Findings from the plugin's data alone. */
export function siteFindings(model: BuildModel): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  const { state } = model;
  const nonDefault = [...state.locales.values()].filter((l) => !l.is_default);

  for (const p of state.stagedPages) {
    const v = model.variantOf.get(p.pageId);
    if (v?.translation_status === "needs_update") {
      out.push({
        rule: "translation-stale",
        severity: "warning",
        pageId: p.pageId,
        message: `Translation out of date: the ${model.displayName(v.locale_code)} version shows an older state of its source page, which changed after it was translated.`,
        fix: {
          tool: "translate_all_stale",
          hint: "Re-translate every stale version in one call; it keeps polished wording where the source did not change.",
        },
      });
    }
  }
  for (const c of state.staleChrome) {
    out.push({
      rule: "chrome-translation-stale",
      severity: "warning",
      message: `Shared content out of date: the ${model.displayName(c.localeCode)} version of ${c.label} was translated before its source changed.`,
      fix: {
        tool: "translate_chrome",
        hint: `translate_chrome({ localeCode: "${c.localeCode}" }) re-translates the stale shared content of that language.`,
      },
    });
  }

  const pagesPerLocale = new Map<string, number>();
  for (const p of state.stagedPages) {
    const l = model.localeOf(p.pageId);
    pagesPerLocale.set(l, (pagesPerLocale.get(l) ?? 0) + 1);
  }
  const homes = model.homes();
  for (const l of nonDefault) {
    const count = pagesPerLocale.get(l.code) ?? 0;
    if (count === 0) {
      out.push({
        rule: "locale-empty",
        severity: "warning",
        message: `Language without pages: ${l.display_name} (${l.code}) is registered, but no page is published in it. Visitors and search engines find nothing there.`,
        fix: {
          tool: "create_variant",
          hint: "Create and translate the pages the operator wants in this language (start with the home page), or remove the language with set_locales.",
        },
      });
    } else if (state.siteHomePageId && !homes.has(l.code)) {
      out.push({
        rule: "locale-home-missing",
        severity: "error",
        message: `Language home missing: ${count} page(s) are published in ${l.display_name} (${l.code}), but its home page is not, so the language's root address answers 404.`,
        fix: {
          tool: "create_variant",
          hint: `create_variant for the site's home page in "${l.code}" (no slug: it becomes the language root), translate it, and publish it with the other pages.`,
        },
      });
    }
  }

  for (const [groupId, members] of model.membersOf) {
    const byLocale = new Map<string, string[]>();
    for (const m of members) {
      byLocale.set(m.locale_code, [...(byLocale.get(m.locale_code) ?? []), m.page_id]);
    }
    const doubled = [...byLocale.entries()].filter(([, ids]) => ids.length > 1);
    const staged = members.find((m) => model.pathOf.has(m.page_id));
    if (doubled.length > 0) {
      out.push({
        rule: "variant-group-broken",
        severity: "error",
        ...(staged ? { pageId: staged.page_id } : {}),
        message: `Two versions of one language: the language group ${groupId} holds ${doubled
          .map(([l, ids]) => `${ids.length} ${model.displayName(l)} pages`)
          .join(
            ", ",
          )}. hreflang and the language switch cannot say which one is the page's version.`,
        fix: {
          tool: "unlink_page_variants",
          hint: "Unlink the page that is not this page's language version (intl_status lists the group).",
        },
      });
    }
    if (!members.some((m) => m.translation_status === "source")) {
      out.push({
        rule: "variant-group-broken",
        severity: "error",
        ...(staged ? { pageId: staged.page_id } : {}),
        message: `Language group without source: group ${groupId} has no source page any more, so its versions cannot be translated or kept up to date.`,
        fix: {
          tool: "link_page_variants",
          hint: "Link the original page into the group again as its source, or unlink the remaining versions.",
        },
      });
    }
  }

  if (nonDefault.length > 0) {
    const sourcePages = pagesPerLocale.get(model.defaultLocale.code) ?? 0;
    out.push({
      rule: "coverage",
      severity: "info",
      message: `Language coverage: ${[...state.locales.values()]
        .map((l) => `${l.display_name} ${pagesPerLocale.get(l.code) ?? 0}`)
        .join(
          ", ",
        )} published page(s); ${model.defaultLocale.display_name} has ${sourcePages}. A page missing in a language answers 404 there by design.`,
      fix: {
        tool: "intl_status",
        hint: "intl_status lists which pages exist in which language; translate the pages the operator wants with create_variant + translate_variant.",
      },
    });
  }
  return out;
}

/**
 * Fact batches for the page rules: whole variant groups first (a page is
 * checked next to its versions), then every other page.
 */
export function factBatchesOf(model: BuildModel): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
  };
  const seen = new Set<string>();
  for (const members of model.membersOf.values()) {
    const staged = members.map((m) => m.page_id).filter((id) => model.pathOf.has(id));
    if (staged.length === 0) continue;
    if (current.length + staged.length > FACT_BATCH_PAGES) flush();
    current.push(...staged);
    for (const id of staged) seen.add(id);
  }
  for (const p of model.state.stagedPages) {
    if (seen.has(p.pageId)) continue;
    if (current.length >= FACT_BATCH_PAGES) flush();
    current.push(p.pageId);
  }
  flush();
  return batches;
}

// ---------------------------------------------------------------------------
// Page rules (fact batches).
// ---------------------------------------------------------------------------

/** Findings about the pages of one fact batch. */
export function pageFindings(
  model: BuildModel,
  facts: readonly PluginAuditPageFacts[],
): PluginAuditFinding[] {
  const byId = new Map(facts.map((f) => [f.pageId, f]));
  const out: PluginAuditFinding[] = [];
  for (const f of facts) {
    out.push(...documentLanguage(model, f));
    out.push(...hreflang(model, f, byId));
    out.push(...languageLinks(model, f));
    const sourceId = model.sourceOf(f.pageId);
    const source = sourceId && sourceId !== f.pageId ? byId.get(sourceId) : undefined;
    if (source) out.push(...contentLanguage(model, f, source));
    out.push(...glossary(model, f));
    out.push(...numberFormat(model, f));
  }
  return out;
}

function documentLanguage(model: BuildModel, f: PluginAuditPageFacts): PluginAuditFinding[] {
  const locale = model.localeOf(f.pageId);
  const out: PluginAuditFinding[] = [];
  if (f.lang === null || !sameLanguage(f.lang, locale)) {
    out.push({
      rule: "html-lang-mismatch",
      severity: "error",
      pageId: f.pageId,
      message: `Wrong page language: the page is the ${model.displayName(locale)} (${locale}) version, but its <html lang> says ${f.lang === null ? "nothing" : quote(f.lang)}. Screen readers pronounce it wrong and search engines may file it under the wrong language.`,
      fix: model.variantOf.has(f.pageId)
        ? {
            tool: "intl_status",
            hint: "The plugin sets <html lang> from the page's language group; check the page's group and language with intl_status and relink it (link_page_variants) if the language is wrong.",
          }
        : {
            tool: "link_page_variants",
            hint: "A page in no language group is labelled with the site language. Link it into its group with its real language, or fix the site language (set_site_identity) if every page is affected.",
          },
    });
  }
  if (f.ogLocale !== null && !sameLanguage(f.ogLocale, locale)) {
    out.push({
      rule: "og-locale-mismatch",
      severity: "info",
      pageId: f.pageId,
      message: `Social preview language: og:locale says ${quote(f.ogLocale)} on the ${model.displayName(locale)} version.`,
    });
  }
  const sourceId = model.sourceOf(f.pageId);
  const sourcePath = sourceId ? model.pathOf.get(sourceId) : undefined;
  if (sourcePath && sourceId !== f.pageId && model.state.siteHomePageId !== sourceId) {
    const mine = f.path.split("/").filter(Boolean).at(-1) ?? "";
    const theirs = sourcePath.split("/").filter(Boolean).at(-1) ?? "";
    const sourceLocale = model.localeOf(sourceId as string);
    if (
      mine !== "" &&
      mine === theirs &&
      /\p{L}{3}/u.test(mine) &&
      primary(sourceLocale) !== primary(locale)
    ) {
      out.push({
        rule: "slug-untranslated",
        severity: "info",
        pageId: f.pageId,
        message: `Address in the source language: the ${model.displayName(locale)} version lives at ${f.path}, with the ${model.displayName(sourceLocale)} slug "${mine}".`,
        fix: {
          tool: "update_pages_many",
          hint: "Give the version a slug in its own language; the redirect from the old address is created automatically (skill localize-slugs).",
        },
      });
    }
  }
  return out;
}

/** Is `tag` a valid hreflang value? Returns the problem, or null. */
export function hreflangProblem(tag: string): string | null {
  if (tag.toLowerCase() === "x-default") return null;
  try {
    Intl.getCanonicalLocales(tag);
  } catch {
    return `${quote(tag)} is not a language tag`;
  }
  const region = tag.split(/[-_]/)[1];
  if (region && WRONG_REGIONS[region.toUpperCase()]) {
    return `${quote(tag)} uses the region "${region}", which is not a country code — use "${WRONG_REGIONS[region.toUpperCase()]}"`;
  }
  return null;
}

function hreflang(
  model: BuildModel,
  f: PluginAuditPageFacts,
  byId: ReadonlyMap<string, PluginAuditPageFacts>,
): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  const versions = model.versionsOf(f.pageId);
  const locale = model.localeOf(f.pageId);

  const problems = [...new Set(f.alternates.flatMap((a) => hreflangProblem(a.hreflang) ?? []))];
  const codes = f.alternates.map((a) => a.hreflang.toLowerCase());
  const doubled = [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))];
  if (problems.length > 0 || doubled.length > 0) {
    out.push({
      rule: "hreflang-invalid-code",
      severity: "error",
      pageId: f.pageId,
      message: `Invalid hreflang: ${[
        ...problems,
        ...doubled.map((c) => `"${c}" is listed twice`),
      ].join("; ")}. Search engines ignore the whole set when it is invalid.`,
      fix: {
        tool: "set_locales",
        hint: "Register the languages with valid BCP 47 codes (en-GB, not en-UK); the plugin derives hreflang from the registry.",
      },
    });
  }

  if (versions.size < 2) return out;
  const listed = new Map<string, string | null>();
  for (const a of f.alternates) listed.set(a.hreflang.toLowerCase(), a.path);

  if (![...listed.values()].includes(f.path)) {
    out.push({
      rule: "hreflang-self-missing",
      severity: "error",
      pageId: f.pageId,
      message: `hreflang without the page itself: the ${model.displayName(locale)} version lists its other versions but not its own address. Search engines require the self-reference and ignore the set without it.`,
      fix: {
        tool: "link_page_variants",
        hint: "Check the page's language group with intl_status; relinking it regenerates hreflang. If the group is right, report the bug with bug_report.",
      },
    });
  }
  // The page itself is hreflang-self-missing's.
  const missing = [...versions.entries()].filter(
    ([code, id]) => id !== f.pageId && listed.get(code.toLowerCase()) !== model.pathOf.get(id),
  );
  if (missing.length > 0) {
    out.push({
      rule: "hreflang-missing-version",
      severity: "error",
      pageId: f.pageId,
      message: `hreflang incomplete: published versions missing from this page's hreflang list: ${missing
        .map(([code, id]) => `${model.displayName(code)} ${model.pathOf.get(id)}`)
        .join(", ")}.`,
      fix: {
        tool: "intl_status",
        hint: "hreflang lists every published version of the group; check that the versions are linked into one group (link_page_variants).",
      },
    });
  }
  const broken = f.alternates.filter(
    (a) =>
      a.hreflang.toLowerCase() !== "x-default" && (a.path === null || !model.pageAt.has(a.path)),
  );
  if (broken.length > 0) {
    out.push({
      rule: "hreflang-target-broken",
      severity: "error",
      pageId: f.pageId,
      message: `hreflang to a missing page: ${broken
        .slice(0, MAX_EXAMPLES)
        .map((a) => `${a.hreflang} → ${a.href}`)
        .join(
          ", ",
        )} is not a page of this build. Search engines drop the alternate and may distrust the set.`,
      fix: {
        tool: "intl_status",
        hint: "Publish the missing version or unlink it from the group (unlink_page_variants).",
      },
    });
  }
  const defaultVersion = versions.get(model.defaultLocale.code);
  const xDefault = listed.get("x-default");
  if (defaultVersion && xDefault !== model.pathOf.get(defaultVersion)) {
    out.push({
      rule: "x-default-missing",
      severity: "warning",
      pageId: f.pageId,
      message:
        xDefault === undefined
          ? `No x-default: the page's hreflang set has no x-default, so search engines do not know which version to show visitors of other languages.`
          : `x-default points elsewhere: it names ${xDefault ?? "an external address"}, not the ${model.defaultLocale.display_name} version ${model.pathOf.get(defaultVersion)}.`,
      fix: {
        tool: "set_locales",
        hint: "x-default follows the default language; check which language is the default (intl_status).",
      },
    });
  }
  for (const a of f.alternates) {
    const targetId = a.path ? model.pageAt.get(a.path) : undefined;
    const target = targetId && targetId !== f.pageId ? byId.get(targetId) : undefined;
    if (!target) continue;
    if (!target.alternates.some((b) => b.path === f.path)) {
      out.push({
        rule: "hreflang-not-reciprocal",
        severity: "error",
        pageId: f.pageId,
        message: `hreflang not confirmed: this page names ${target.path} as its ${a.hreflang} version, but ${target.path} does not name this page back. Search engines ignore one-sided alternates.`,
        fix: {
          tool: "intl_status",
          hint: "Both pages must be in one language group and both published; check with intl_status and relink with link_page_variants.",
        },
      });
    }
    const noindex = target.robots?.includes("noindex") ?? false;
    const canonicalElsewhere = target.canonical !== null && target.canonical.path !== target.path;
    if (noindex || canonicalElsewhere) {
      out.push({
        rule: "hreflang-target-not-indexable",
        severity: "error",
        pageId: f.pageId,
        message: `hreflang to a page search engines may not index: ${target.path} (${a.hreflang}) ${noindex ? "is noindex" : `has its canonical at ${target.canonical?.href}`}. Search engines then discard the alternates of the whole group.`,
        fix: {
          tool: "set_page_seo",
          hint: `Make ${target.path} indexable with a self-referencing canonical, or unlink it from the group if it should not be found.`,
        },
      });
    }
  }
  if (f.canonical?.path) {
    const canonicalPage = model.pageAt.get(f.canonical.path);
    if (
      canonicalPage &&
      canonicalPage !== f.pageId &&
      [...versions.values()].includes(canonicalPage)
    ) {
      out.push({
        rule: "canonical-cross-locale",
        severity: "error",
        pageId: f.pageId,
        message: `Canonical to another language: the ${model.displayName(locale)} version names ${f.canonical.path} (${model.displayName(model.localeOf(canonicalPage))}) as its canonical, so search engines drop this version from the index.`,
        fix: {
          tool: "set_page_seo",
          hint: "Remove the canonical override; every language version is canonical to itself.",
        },
      });
    }
  }
  if (Array.isArray(f.sitemapAlternates)) {
    const inSitemap = new Map(
      (f.sitemapAlternates as PluginAuditPageFacts["alternates"]).map((a) => [
        a.hreflang.toLowerCase(),
        a.path,
      ]),
    );
    const differs =
      inSitemap.size !== listed.size ||
      [...listed.entries()].some(([k, v]) => inSitemap.get(k) !== v);
    if (differs) {
      out.push({
        rule: "sitemap-alternates-mismatch",
        severity: "error",
        pageId: f.pageId,
        message: `Sitemap and page disagree: the sitemap lists ${inSitemap.size} language version(s) for this page, its hreflang tags ${listed.size}. Search engines get two different answers.`,
        fix: {
          tool: "bug_report",
          hint: "Both come from the plugin's group data in one build; a difference is a Caelo bug — report it.",
        },
      });
    }
  }
  return out;
}

function languageLinks(model: BuildModel, f: PluginAuditPageFacts): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  const locale = model.localeOf(f.pageId);
  const versions = model.versionsOf(f.pageId);
  const homes = model.homes();
  let reachesVersion = false;
  for (const l of f.links) {
    if (l.path === null) continue;
    const target = model.localeOfPath(l.path);
    const hinted = l.hreflang ?? null;
    const linkLocale = hinted
      ? ([...model.state.locales.keys()].find((c) => sameLanguage(hinted, c)) ?? target)
      : target;
    if (linkLocale === null || linkLocale === locale) continue;
    const counterpart = versions.get(linkLocale);
    const counterpartPath = counterpart ? model.pathOf.get(counterpart) : undefined;
    if (counterpartPath === l.path) {
      reachesVersion = true;
      continue;
    }
    const homePath = homes.get(linkLocale);
    const isHome = homePath !== undefined && model.pathOf.get(homePath) === l.path;
    const named = languageNames(linkLocale, model).has(l.text.trim().toLowerCase());
    const isLanguageLink = hinted !== null || named || isHome;
    if (!isLanguageLink) {
      const targetPage = model.pageAt.get(l.path);
      const own = targetPage ? model.versionsOf(targetPage).get(locale) : undefined;
      if (own) {
        out.push({
          rule: "cross-locale-content-link",
          severity: "warning",
          pageId: f.pageId,
          message: `Link into another language: ${quote(l.text || l.href)} on the ${model.displayName(locale)} version leads to the ${model.displayName(linkLocale)} page ${l.path}, although ${model.pathOf.get(own)} exists in this page's language.`,
          fix: {
            tool: "edit_content",
            hint: `Link the page itself (a page link follows each page's language automatically) instead of the literal ${l.path}.`,
          },
        });
      }
      continue;
    }
    if (isHome && counterpart) {
      out.push({
        rule: "switcher-to-home",
        severity: "warning",
        message: `Language switch to the home page: the link ${quote(l.text)} in ${whereOf(l.moduleId, l.pluginSlug)} leads to the ${model.displayName(linkLocale)} home page, although the current page has a ${model.displayName(linkLocale)} version. Visitors lose their place.`,
        fix: {
          tool: "edit_module",
          hint: "Build the language switch from the language_links list source ({{#language_links}}…{{/language_links}}): each entry is the current page's own version.",
        },
      });
      continue;
    }
    out.push({
      rule: "hardcoded-language-link",
      severity: "error",
      message: `Hardcoded language link: ${quote(l.text || l.href)} → ${l.href} in ${whereOf(l.moduleId, l.pluginSlug)} is a fixed address, so on pages without a ${model.displayName(linkLocale)} version, or with another one, it leads to the wrong page or a 404.`,
      fix: {
        tool: "edit_module",
        hint: 'Replace the fixed link with the language_links list source: <nav>{{#language_links}}<a href="{{href}}" hreflang="{{locale}}">{{label}}</a>{{/language_links}}</nav>. It lists exactly the published versions of each page.',
      },
    });
  }
  if (versions.size >= 2 && !reachesVersion) {
    out.push({
      rule: "switcher-missing",
      severity: "warning",
      message:
        "Language switch missing: pages that exist in several languages offer visitors no link to their other versions.",
      fix: {
        tool: "add_module",
        hint: "Place a language switch module in the layout that iterates the language_links list source; one placement covers every page (skill add-language, step 6).",
      },
    });
  }
  return out;
}

/** Text a visitor reads that can be compared across languages. */
function comparable(text: string): boolean {
  if (!/\p{L}.*\p{L}.*\p{L}/u.test(text)) return false;
  if (/^(https?:|mailto:|tel:|\/)/i.test(text) || /^\S+@\S+$/.test(text)) return false;
  return true;
}

function contentLanguage(
  model: BuildModel,
  f: PluginAuditPageFacts,
  source: PluginAuditPageFacts,
): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  const locale = model.localeOf(f.pageId);
  const sourceLocale = model.localeOf(source.pageId);
  if (primary(locale) === primary(sourceLocale)) return out;
  const kept = new Set(
    model.state.glossary
      .filter((g) => g.locale_code === locale && g.term.trim() === g.translation.trim())
      .map((g) => g.term.trim().toLowerCase()),
  );
  const sourceTexts = new Set(source.texts.filter((t) => t.source !== "alt").map((t) => t.text));
  const sourceAlts = new Set(source.texts.filter((t) => t.source === "alt").map((t) => t.text));
  const same = (t: PluginAuditPageFacts["texts"][number]) =>
    comparable(t.text) && !kept.has(t.text.toLowerCase());

  const body = f.texts.filter(
    (t) => t.source !== "alt" && !(t.moduleId && model.state.chromeModuleIds.has(t.moduleId)),
  );
  const identical = body.filter((t) => same(t) && sourceTexts.has(t.text));
  const total = body.reduce((n, t) => n + t.text.length, 0);
  const left = identical.reduce((n, t) => n + t.text.length, 0);
  const examples = (ts: readonly { text: string }[]) =>
    [...new Set(ts.map((t) => t.text))]
      .slice(0, MAX_EXAMPLES)
      .map((t) => quote(t, 40))
      .join(", ");
  const modules = (ts: readonly { moduleId: string | null }[]) => [
    ...new Set(ts.flatMap((t) => (t.moduleId ? [t.moduleId] : []))),
  ];

  if (total >= MIN_TEXT_FOR_LANGUAGE && left / total >= WRONG_LANGUAGE_SHARE) {
    out.push({
      rule: "content-wrong-language",
      severity: "error",
      pageId: f.pageId,
      message: `Page in the wrong language: ${Math.round((100 * left) / total)}% of the text on the ${model.displayName(locale)} version is identical to the ${model.displayName(sourceLocale)} source (${examples(identical)}). The page was not translated.`,
      fix: {
        tool: "translate_variant",
        hint: "Translate the page; it covers every placement, the texts modules show from their defaults, and nested content.",
      },
    });
  } else if (identical.length > 0) {
    const ms = modules(identical);
    out.push({
      rule: "content-mixed-language",
      severity: "warning",
      pageId: f.pageId,
      message: `Untranslated text: the ${model.displayName(locale)} version still shows ${model.displayName(sourceLocale)} text: ${examples(identical)}${ms.length > 0 ? ` (module ${ms.slice(0, MAX_EXAMPLES).join(", ")})` : ""}.`,
      fix: {
        tool: "translate_variant",
        hint: "Run translate_variant on this version; if the text is a brand or product name that stays the same in every language, add it to the glossary with itself as translation (set_glossary_term).",
      },
    });
  }

  const chrome = f.texts.filter(
    (t) =>
      t.source !== "alt" &&
      t.moduleId !== null &&
      model.state.chromeModuleIds.has(t.moduleId) &&
      same(t) &&
      sourceTexts.has(t.text),
  );
  for (const moduleId of modules(chrome)) {
    out.push({
      rule: "chrome-untranslated",
      severity: "warning",
      message: `Shared content not translated: module ${moduleId} (header, footer or menu) shows ${model.displayName(sourceLocale)} text on ${model.displayName(locale)} pages: ${examples(chrome.filter((t) => t.moduleId === moduleId))}.`,
      fix: {
        tool: "translate_chrome",
        hint: `translate_chrome({ localeCode: "${locale}" }) translates the shared content of that language; set_chrome_variants gives it its own content instead.`,
      },
    });
  }

  const alts = f.texts.filter((t) => t.source === "alt" && same(t) && sourceAlts.has(t.text));
  if (alts.length > 0) {
    out.push({
      rule: "alt-untranslated",
      severity: "warning",
      pageId: f.pageId,
      message: `Image descriptions not translated: ${alts.length} image(s) on the ${model.displayName(locale)} version keep their ${model.displayName(sourceLocale)} alt text (${examples(alts)}).`,
      fix: {
        tool: "translate_variant",
        hint: "Run translate_variant on this version; alt texts stored with the content are translated with it.",
      },
    });
  }

  const sameTitle = f.title !== null && f.title !== "" && f.title === source.title;
  const sameDescription =
    f.metaDescription !== null &&
    f.metaDescription !== "" &&
    f.metaDescription === source.metaDescription;
  if (sameTitle || sameDescription) {
    out.push({
      rule: "seo-untranslated",
      severity: "error",
      pageId: f.pageId,
      message: `Search snippet not translated: the ${model.displayName(locale)} version has the same ${[
        sameTitle ? "title" : null,
        sameDescription ? "meta description" : null,
      ]
        .filter(Boolean)
        .join(
          " and ",
        )} as the ${model.displayName(sourceLocale)} source, so search results show it in the wrong language.`,
      fix: {
        tool: "set_page_seo_many",
        hint: "Write the title and meta description in the page's language (translate_variant fills them for a version that has none yet).",
      },
    });
  }
  return out;
}

function glossary(model: BuildModel, f: PluginAuditPageFacts): PluginAuditFinding[] {
  const locale = model.localeOf(f.pageId);
  if (locale === model.defaultLocale.code) return [];
  const text = f.texts.map((t) => t.text).join(" \n ");
  const hits = model.state.glossary.filter((g) => {
    if (g.locale_code !== locale) return false;
    const term = g.term.trim();
    const translation = g.translation.trim();
    if (term === "" || term.toLowerCase() === translation.toLowerCase()) return false;
    return containsWord(text, term) && !containsWord(text, translation);
  });
  if (hits.length === 0) return [];
  return [
    {
      rule: "glossary-violation",
      severity: "warning",
      pageId: f.pageId,
      message: `Glossary not followed: the ${model.displayName(locale)} version uses ${hits
        .slice(0, MAX_EXAMPLES)
        .map((g) => `${quote(g.term, 30)} where the glossary says ${quote(g.translation, 30)}`)
        .join(", ")}.`,
      fix: {
        tool: "translate_variant",
        hint: "Re-translate the version (update mode keeps the rest); the glossary is part of every translation call.",
      },
    },
  ];
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** The decimal separator of a locale (`,` for de, `.` for en). */
function decimalSeparator(locale: string): string | null {
  try {
    return (
      new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ??
      null
    );
  } catch {
    return null;
  }
}

/** `1.234,56` (comma decimals). */
const COMMA_DECIMAL = /(^|[^\d.,])\d{1,3}(?:\.\d{3})+,\d{1,2}(?![\d.,])/;
/** `1,234.56` (point decimals). */
const POINT_DECIMAL = /(^|[^\d.,])\d{1,3}(?:,\d{3})+\.\d{1,2}(?![\d.,])/;

function numberFormat(model: BuildModel, f: PluginAuditPageFacts): PluginAuditFinding[] {
  const locale = model.localeOf(f.pageId);
  const sep = decimalSeparator(locale);
  if (sep === null) return [];
  const wrong = sep === "." ? COMMA_DECIMAL : sep === "," ? POINT_DECIMAL : null;
  if (!wrong) return [];
  const hit = f.texts.find((t) => wrong.test(t.text));
  if (!hit) return [];
  return [
    {
      rule: "locale-format",
      severity: "info",
      pageId: f.pageId,
      message: `Number format of another language: ${quote(hit.text, 50)} on the ${model.displayName(locale)} version writes numbers with ${sep === "." ? "a decimal comma" : "a decimal point"}.`,
      fix: {
        tool: "edit_content",
        hint: `Write numbers, prices and dates the way ${model.displayName(locale)} readers expect.`,
      },
    },
  ];
}
