// SPDX-License-Identifier: MPL-2.0

/**
 * The document language — the `lang` attribute on `<html>`.
 *
 * Screen readers pick their pronunciation from it and search engines
 * use it to classify the page, so every page Caelo renders must carry
 * one. Like `<title>` and the rest of the SEO head, it is a structured
 * value owned by core, never something a layout author hand-writes:
 * the composed page always carries the value core resolved, replacing
 * whatever `lang` the layout HTML happened to contain.
 *
 * Where the value comes from (resolved identically by the admin
 * preview and the static generator):
 *   1. the per-page language a plugin contributes through the head
 *      contribution point (the `international-site` plugin knows each
 *      page's locale — core does not, since epic #380), else
 *   2. the site's stored language (`site_defaults.site_language`,
 *      seeded `en` by migration and edited via `set_site_identity`).
 * Step 2 is stored data, not a read-time fallback (CLAUDE.md §2): the
 * column is NOT NULL, so there is no "missing language" state to
 * paper over.
 */

import { z } from "zod";

/**
 * A BCP 47 language tag as accepted for `<html lang>`: a 2–8 letter
 * primary subtag followed by optional alphanumeric subtags (`en`,
 * `de-AT`, `zh-Hant-TW`). Deliberately structural rather than a full
 * registry check — the same shape the `site_defaults.site_language`
 * CHECK constraint enforces.
 */
export const languageTagSchema = z
  .string()
  .max(35)
  .regex(
    /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/,
    "must be a BCP 47 language tag such as `en`, `de` or `pt-BR`",
  );

/**
 * Pick the language for one page: a plugin-contributed per-page value
 * wins over the site's stored language. Exported so preview and build
 * resolve through the same expression.
 */
export function resolveDocumentLanguage(args: {
  readonly contributed: string | undefined;
  readonly siteLanguage: string;
}): string {
  return args.contributed ?? args.siteLanguage;
}

// The `<html` start-tag opener; the lookahead keeps look-alikes such as
// `<html-widget>` out. Fixed-width, so matching is linear.
const HTML_TAG_OPENER_RE = /<html(?=[\s>/])/i;
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i;
// HTML's ASCII whitespace (the tokenizer's attribute separators).
const HTML_WS = new Set(["\t", "\n", "\f", "\r", " "]);

/**
 * Scan the attributes of the start tag beginning at `from` (just past
 * `<html`) and return them with every `lang` attribute removed, plus the
 * index just past the closing `>`. `null` when the tag never closes.
 *
 * A single forward pass over the tag, character by character: layout
 * HTML is AI- or operator-authored input, and a backtracking regex over
 * it (`\s+lang…` with a global flag) is polynomial on long whitespace
 * runs (CodeQL js/polynomial-redos). Quoted values may contain `>`.
 * `xml:lang` and `data-lang` are different attribute names and survive.
 */
function stripLangAttributes(
  html: string,
  from: number,
): { readonly attrs: string; readonly end: number } | null {
  const n = html.length;
  let i = from;
  let attrs = "";
  while (i < n) {
    const segmentStart = i;
    while (i < n && HTML_WS.has(html[i] as string)) i++;
    if (i >= n) return null;
    if (html[i] === ">") return { attrs: attrs + html.slice(segmentStart, i), end: i + 1 };
    const nameStart = i;
    // An attribute name runs to whitespace, `=`, `>` or `/`; a stray `=`
    // or `/` is consumed as a one-character name so the scan always moves.
    i++;
    while (i < n && !HTML_WS.has(html[i] as string) && !"=>/".includes(html[i] as string)) i++;
    const name = html.slice(nameStart, i).toLowerCase();
    const afterName = i;
    while (i < n && HTML_WS.has(html[i] as string)) i++;
    if (html[i] === "=") {
      i++;
      while (i < n && HTML_WS.has(html[i] as string)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return null;
        i = close + 1;
      } else {
        while (i < n && !HTML_WS.has(html[i] as string) && html[i] !== ">") i++;
      }
    } else {
      // No value: the whitespace belongs to the next attribute.
      i = afterName;
    }
    if (name !== "lang") attrs += html.slice(segmentStart, i);
  }
  return null;
}

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Set `lang` on the document's `<html>` start tag, replacing any value
 * the layout carried. A layout with no `<html>` start tag (the tag is
 * optional in HTML) gets one inserted right after the doctype, which
 * parses to the same document with the language attached. An `<html`
 * start tag that never closes is malformed and treated as absent.
 */
export function applyDocumentLanguage(html: string, lang: string): string {
  const attr = ` lang="${escapeAttr(lang)}"`;
  const open = HTML_TAG_OPENER_RE.exec(html);
  const tag = open ? stripLangAttributes(html, open.index + "<html".length) : null;
  if (open && tag) {
    return `${html.slice(0, open.index)}<html${attr}${tag.attrs}>${html.slice(tag.end)}`;
  }
  const doctype = DOCTYPE_RE.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<html${attr}>${html.slice(at)}`;
}
