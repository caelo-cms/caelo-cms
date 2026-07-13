// SPDX-License-Identifier: MPL-2.0

/**
 * issue #278 — page-type classification for homepage-driven migration.
 *
 * Run #11 crawled 357 URLs (both /de and /en, plus /category, /tag, date
 * archives, author pages) for a "migrate searchviu.com/en" request and
 * then couldn't proceed. The fix (issue #278) is to understand structure
 * from the homepage BEFORE any crawl: read the nav + footer links (and a
 * sitemap sample as backstop), group them into the site's real page
 * TYPES — pricing, blog-article, use-cases — with one representative
 * sample URL each, and drop the archive/tag/date/author noise entirely.
 *
 * "AI decides, code executes": this pure function produces the type map
 * + the WHY for each type; the AI names the types to the operator and
 * picks which to rebuild. No model in the loop here — deterministic URL
 * grouping is the whole trick (mirrors page-signature.ts's clustering,
 * but keyed on the homepage's OWN links rather than a crawl's output).
 *
 * All scans are string/URL ops — no regex over document text (#113).
 */

import type { LinkLocation } from "./page-facets.js";

/** A homepage link fed to the classifier. Body-located links are ignored
 *  (the classifier weighs nav + footer only); pass the full set — it
 *  filters internally. */
export interface ClassifierLink {
  readonly href: string;
  readonly text: string;
  readonly location: LinkLocation;
}

/** Which discovery source introduced a page type (importance order). */
export type PageTypeSource = "nav" | "footer" | "sitemap";

/** One distinct page type the site exposes, with one sample to build from. */
export interface PageType {
  /** Semantic slug the AI renames for the operator: nav/footer label
   *  slug for single pages, `<section>-article` for collections. */
  readonly type: string;
  /** The URL section this type groups under, e.g. "blog", "pricing". */
  readonly section: string;
  /** One representative URL — a collection's item (e.g. /blog/a-post),
   *  or the page itself for singletons. */
  readonly sampleUrl: string;
  readonly source: PageTypeSource;
  /** True when the section groups multiple pages sharing a URL pattern
   *  (e.g. many /blog/* → one blog-article type). */
  readonly collection: boolean;
  /** Distinct URLs that collapsed into this type. */
  readonly memberCount: number;
  /** Human-readable justification for the AI to name the type, e.g.
   *  `nav label "Pricing"` or `sitemap: 12 pages under /blog/`. */
  readonly evidence: string;
}

/** A URL the classifier dropped as noise, with why (transparency). */
export interface FilteredUrl {
  readonly url: string;
  readonly reason: string;
}

export interface PageTypeMap {
  /** Distinct types, ordered by importance: nav-linked, then footer-only,
   *  then sitemap-only; discovery order within each band. */
  readonly types: readonly PageType[];
  /** Noise dropped by pattern (archives/tags/dates/authors/pagination,
   *  other-locale prefixes), capped for reporting. */
  readonly filtered: readonly FilteredUrl[];
  /** The locale prefix the map was scoped to (from the site URL), or ""
   *  when the migrated URL carries no locale segment. */
  readonly activeLocale: string;
}

export interface ClassifyPageTypesInput {
  /** The homepage / base URL being migrated. Fixes the host + the active
   *  locale prefix (e.g. searchviu.com/en → "en"). */
  readonly siteUrl: string;
  /** Homepage links (nav + footer + body). Body-located links ignored. */
  readonly links: readonly ClassifierLink[];
  /** Optional sitemap.xml sample (already sampled — pass tens, not
   *  thousands). Absolute URLs. */
  readonly sitemapUrls?: readonly string[];
}

const MAX_FILTERED_REPORTED = 60;
const MAX_TYPES = 40;

/**
 * Common ISO-639-1 language codes used to recognise a locale URL segment
 * (`/de`, `/fr`, `/pt-br`). Deliberately a curated set, not "any two
 * letters", so a real `/id` (an "id" page) or `/it` (an IT section)
 * isn't mistaken for a locale unless it's a plausible language code AND
 * differs from the migrated locale.
 */
const LOCALE_CODES = new Set([
  "aa",
  "ab",
  "af",
  "ak",
  "am",
  "ar",
  "as",
  "az",
  "be",
  "bg",
  "bm",
  "bn",
  "bo",
  "br",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "dz",
  "ee",
  "el",
  "en",
  "eo",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fo",
  "fr",
  "ga",
  "gd",
  "gl",
  "gu",
  "ha",
  "he",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "id",
  "ig",
  "is",
  "it",
  "ja",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "ku",
  "ky",
  "la",
  "lb",
  "lo",
  "lt",
  "lv",
  "mg",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "nb",
  "ne",
  "nl",
  "nn",
  "no",
  "or",
  "pa",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "rw",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "sq",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "ti",
  "tk",
  "tr",
  "tt",
  "uk",
  "ur",
  "uz",
  "vi",
  "xh",
  "yi",
  "yo",
  "zh",
  "zu",
]);

/** A path segment that reads as a locale (`de`, `pt-br`)? */
function isLocaleSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  if (LOCALE_CODES.has(s)) return true;
  const dash = s.indexOf("-");
  return dash === 2 && LOCALE_CODES.has(s.slice(0, 2)) && s.length <= 5;
}

const SECTION_NOISE = new Set(["tag", "tags", "category", "categories", "author", "authors"]);

/** Split a pathname into non-empty lowercased segments. */
function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

/** Slugify a label → lowercase-dash slug, or "" when nothing survives. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

interface Candidate {
  readonly url: string;
  readonly section: string;
  readonly depth: number;
  readonly label: string;
  readonly source: PageTypeSource;
}

/**
 * Classify a homepage's links (+ a sitemap sample) into the site's page
 * types. Filters other-locale prefixes and archive/tag/date/author/
 * pagination noise; groups the rest by URL section into one type each
 * with a representative sample and a WHY the AI can rename.
 */
export function classifyPageTypes(input: ClassifyPageTypesInput): PageTypeMap {
  let host: string;
  let activeLocale = "";
  try {
    const site = new URL(input.siteUrl);
    host = site.host;
    const first = segmentsOf(site.pathname)[0];
    if (first && isLocaleSegment(first)) activeLocale = first.toLowerCase();
  } catch {
    return { types: [], filtered: [], activeLocale: "" };
  }

  const filtered: FilteredUrl[] = [];
  const pushFiltered = (url: string, reason: string): void => {
    if (filtered.length < MAX_FILTERED_REPORTED) filtered.push({ url, reason });
  };

  // Process order fixes importance: nav links, then footer, then sitemap.
  // A section's FIRST-seen source wins — so nav sections sort ahead of
  // footer-only ahead of sitemap-only, which is exactly the ordering the
  // discovery step wants.
  const navLinks = input.links.filter((l) => l.location === "nav");
  const footerLinks = input.links.filter((l) => l.location === "footer");
  const ordered: Array<{ url: string; text: string; source: PageTypeSource }> = [
    ...navLinks.map((l) => ({ url: l.href, text: l.text, source: "nav" as const })),
    ...footerLinks.map((l) => ({ url: l.href, text: l.text, source: "footer" as const })),
    ...(input.sitemapUrls ?? []).map((u) => ({ url: u, text: "", source: "sitemap" as const })),
  ];

  const seenUrls = new Set<string>();
  const candidates: Candidate[] = [];
  for (const entry of ordered) {
    let u: URL;
    try {
      u = new URL(entry.url);
    } catch {
      continue;
    }
    if (u.host !== host) continue; // outbound/off-site — not a page type
    const normalized = `${u.origin}${u.pathname.replace(/\/$/, "") || "/"}`;
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);

    let segs = segmentsOf(u.pathname);
    if (segs.length === 0) continue; // homepage itself — it's the anchor

    // Other-locale prefix: a locale segment that isn't the migrated one.
    const firstSeg = segs[0]?.toLowerCase() ?? "";
    if (isLocaleSegment(firstSeg) && firstSeg !== activeLocale) {
      pushFiltered(normalized, `other-locale prefix /${firstSeg}`);
      continue;
    }
    if (activeLocale && firstSeg === activeLocale) segs = segs.slice(1);
    if (segs.length === 0) continue; // was just the locale home (/en)

    const section = segs[0] ?? "";
    if (SECTION_NOISE.has(section)) {
      pushFiltered(normalized, `${section} archive`);
      continue;
    }
    if (segs.some((s) => /^(19|20)\d{2}$/.test(s))) {
      pushFiltered(normalized, "date archive");
      continue;
    }
    const pageIdx = segs.findIndex((s) => s === "page" || s === "seite");
    if (pageIdx !== -1 && /^\d+$/.test(segs[pageIdx + 1] ?? "")) {
      pushFiltered(normalized, "pagination");
      continue;
    }
    if (/\bpage=\d+/.test(u.search) || /\bseite=\d+/.test(u.search)) {
      pushFiltered(normalized, "pagination");
      continue;
    }

    candidates.push({
      url: normalized,
      section,
      depth: segs.length,
      label: entry.text,
      source: entry.source,
    });
  }

  // Group by section; first source wins (nav > footer > sitemap by order).
  const groups = new Map<string, { source: PageTypeSource; members: Candidate[]; order: number }>();
  let order = 0;
  for (const c of candidates) {
    const g = groups.get(c.section);
    if (g) {
      g.members.push(c);
    } else {
      groups.set(c.section, { source: c.source, members: [c], order: order++ });
    }
  }

  const types: PageType[] = [];
  for (const [section, g] of [...groups.entries()].sort((a, b) => a[1].order - b[1].order)) {
    if (types.length >= MAX_TYPES) break;
    const deepMembers = g.members
      .filter((m) => m.depth > 1)
      .sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
    const collection = g.members.length > 1 && deepMembers.length > 0;
    // Sample: a real item for collections, else the page itself.
    const sampleUrl =
      deepMembers[0]?.url ??
      g.members.find((m) => m.source === "nav" || m.source === "footer")?.url ??
      g.members[0]?.url ??
      section;
    const label = g.members.find((m) => m.label.trim().length > 0)?.label.trim() ?? "";
    const type = collection ? `${section}-article` : slugify(label) || section;
    const evidence = buildEvidence(g.source, label, section, g.members.length, collection);
    types.push({
      type,
      section,
      sampleUrl,
      source: g.source,
      collection,
      memberCount: g.members.length,
      evidence,
    });
  }

  return { types, filtered, activeLocale };
}

function buildEvidence(
  source: PageTypeSource,
  label: string,
  section: string,
  memberCount: number,
  collection: boolean,
): string {
  const labelPart =
    source === "sitemap"
      ? `sitemap: /${section}/`
      : `${source} label ${label ? `"${label}"` : `/${section}`}`;
  if (collection) return `${labelPart} — ${memberCount} pages under /${section}/`;
  return labelPart;
}
