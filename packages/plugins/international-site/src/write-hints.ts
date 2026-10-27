// SPDX-License-Identifier: MPL-2.0

/**
 * Write hints (core's `writeHintsOperation` hook): when the AI writes a
 * module or content values that hardcode a link into another language,
 * it hears about it in the same tool result — before a Stage audit's
 * `hardcoded-language-link` finding has to catch it.
 *
 * A fixed language link is wrong in two ways. A literal `/en/` stays the
 * same on every page, so it leads to the English home instead of the
 * current page's English version, and to a 404 where there is none. A
 * page reference to another language's page is resolved per page to the
 * CURRENT page's language (internal links follow the language), so a
 * language switch built from it never switches. The `language_links`
 * list source is the one correct switch: per page, exactly its published
 * versions.
 */

import type { PluginWrite } from "@caelo-cms/plugin-sdk";
import type { LocaleRow, PageVariantRow } from "./index.js";

/** What the hints read besides the writes. */
export interface WriteHintState {
  readonly locales: ReadonlyMap<string, LocaleRow>;
  readonly prefixDefaultLocale: boolean;
  readonly variants: readonly PageVariantRow[];
  /** The page core serves at `/`. */
  readonly siteHomePageId: string | null;
}

const PAGE_REF = /^caelo:page\/([0-9a-f-]{36})/i;

/** Every link-like string in a value tree (`href` strings, link objects, list entries). */
function hrefsIn(value: unknown, out: string[], depth = 0): void {
  if (depth > 24 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.startsWith("/") || PAGE_REF.test(value)) out.push(value);
    for (const m of value.matchAll(/href\s*=\s*"([^"]+)"/gi)) if (m[1]) out.push(m[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) hrefsIn(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) hrefsIn(v, out, depth + 1);
  }
}

/** The non-template `hreflang="…"` attributes of markup. */
function literalHreflangs(html: string): string[] {
  return [...html.matchAll(/hreflang\s*=\s*"([^"{}]+)"/gi)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/**
 * The hints for `writes` (empty when the site has one language, or when
 * nothing is wrong).
 */
export function writeHints(state: WriteHintState, writes: readonly PluginWrite[]): string[] {
  if (state.locales.size < 2) return [];
  const prefixed = new Map<string, LocaleRow>();
  for (const l of state.locales.values()) {
    if (!l.is_default || state.prefixDefaultLocale) prefixed.set(l.code.toLowerCase(), l);
  }
  const homeGroup = state.siteHomePageId
    ? state.variants.find((v) => v.page_id === state.siteHomePageId)?.group_id
    : undefined;
  const localeHomes = new Map(
    state.variants
      .filter((v) => homeGroup !== undefined && v.group_id === homeGroup)
      .map((v) => [v.page_id, v.locale_code]),
  );
  const found = new Map<string, string>();
  for (const w of writes) {
    if (w.kind === "module" && w.html.includes("{{#language_links}}")) continue;
    const hrefs: string[] = [];
    if (w.kind === "module") {
      hrefsIn(w.html, hrefs);
      for (const f of w.fields) hrefsIn(f.default, hrefs);
      for (const tag of literalHreflangs(w.html)) {
        found.set(`hreflang:${tag}`, `The markup sets hreflang="${tag}" on a fixed link`);
      }
    } else {
      hrefsIn(w.values, hrefs);
    }
    for (const href of hrefs) {
      const ref = PAGE_REF.exec(href);
      if (ref?.[1]) {
        const locale = localeHomes.get(ref[1]);
        const row = locale ? state.locales.get(locale) : undefined;
        // The default home is every logo's link; only another language's
        // home is a language link.
        if (row && !row.is_default && localeHomes.size > 1) {
          found.set(
            href,
            `The link to the ${row.display_name} home page is a page link, which every page resolves to its OWN language — as a language switch it never switches`,
          );
        }
        continue;
      }
      const first = href.split(/[/?#]/)[1]?.toLowerCase();
      const row = first ? prefixed.get(first) : undefined;
      if (row) {
        found.set(
          href,
          `The link to ${href} is a fixed address into the ${row.display_name} version: it is the same on every page, so it leads to the wrong page or a 404 wherever the current page has no such version`,
        );
      }
    }
  }
  if (found.size === 0) return [];
  return [
    `${[...found.values()].slice(0, 3).join(". ")}. For a language switch, iterate the language_links list source instead — <nav>{{#language_links}}<a href="{{href}}" hreflang="{{locale}}"{{#is_current}} aria-current="page"{{/is_current}}>{{label}}</a>{{/language_links}}</nav> — it lists exactly the published versions of each page. For a link to content, link the page itself: page links follow the language of the page they are on.`.slice(
      0,
      600,
    ),
  ];
}
