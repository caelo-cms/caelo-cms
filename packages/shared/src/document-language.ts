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

// `<html` followed by attributes up to the closing `>`, tolerating `>`
// inside quoted attribute values.
const HTML_OPEN_TAG_RE = /<html(?=[\s>/])(?:"[^"]*"|'[^']*'|[^'">])*>/i;
// A `lang` attribute (quoted, unquoted, or bare). The leading
// whitespace requirement keeps `xml:lang` untouched.
const LANG_ATTR_RE = /\s+lang(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?(?=[\s>/])/gi;
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i;

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
 * parses to the same document with the language attached.
 */
export function applyDocumentLanguage(html: string, lang: string): string {
  const attr = ` lang="${escapeAttr(lang)}"`;
  const open = HTML_OPEN_TAG_RE.exec(html);
  if (open) {
    const rest = open[0].slice("<html".length).replace(LANG_ATTR_RE, "");
    const tag = `<html${attr}${rest}`;
    return html.slice(0, open.index) + tag + html.slice(open.index + open[0].length);
  }
  const doctype = DOCTYPE_RE.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<html${attr}>${html.slice(at)}`;
}
