// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the review-time rules for what a plugin puts in a visitor's
 * browser (docs/dev/external-plugin-brokers.md §6.7, decision Q4 B). They
 * run in `validateManifest`, so an installed plugin meets them at staging
 * and a shipped one at every load (one plugin model, decision Q2 A).
 *
 * - **Deferral placeholders** stand in for a module withheld because it
 *   would contact a third party. Nothing in them may load or run: an
 *   element allowlist, an attribute allowlist (no `src`, no `style`, no
 *   `on*`), links held to the page link rule, and CSS that loads nothing.
 *   `{{name}}` slots take escaped text, in text or a quoted attribute value
 *   only, never inside an `href`.
 * - **CSS** of a placeholder or a client file loads nothing from another
 *   origin: no `@import`, and a `url()` is relative, `data:` or an origin
 *   the grant names. CSS escapes are decoded first, so `\75 rl(` is seen as
 *   `url(`.
 */

import { escapePluginText, htmlTokens } from "@caelo-cms/shared";
import { cssTokens } from "./css-tokens.js";

/**
 * A placeholder stands where the withheld module would, which can be raw
 * text (a `<noscript>` the page puts it in): there a `</noscript>` inside an
 * attribute value or a comment ends the raw text, and what follows runs.
 * Every tag of the placeholder is held to the rules already; `<` elsewhere
 * in its markup is refused, so it is safe wherever it lands.
 */
const LT_PROBLEM =
  'a "<" inside an attribute value or a comment: where the placeholder stands in raw text it could end that text — write it as &lt;';

/** Elements a placeholder may hold: prose, containers and a button. Nothing that loads or runs. */
export const PLACEHOLDER_ELEMENTS: ReadonlySet<string> = new Set([
  "div",
  "section",
  "p",
  "span",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "code",
  "br",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "button",
]);

/** Attributes a placeholder element may carry, beside `data-*` and `aria-*`. */
const PLACEHOLDER_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "id",
  "role",
  "title",
  "lang",
  "dir",
  "type",
  "href",
  "hidden",
  "tabindex",
]);

/** A `{{` that is not a plain `{{name}}` slot: sections, partials, raw output. */
const FOREIGN_TEMPLATE_RE = /\{\{\s*(?![a-z][a-z0-9_]*\s*\}\})/;

/** A `{{name}}` slot, as the host fills it with a verdict's escaped text (plugin-host deferrals.ts). */
const SLOT_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/**
 * Text a verdict could hand a slot. Escaped as the host escapes it, it can
 * change the markup only where escaping is not enough: an unquoted
 * attribute value takes `onmouseover=…` as an attribute of its own, and a
 * slot right after a literal `<` makes the text a tag.
 */
const SLOT_PROBE = `x y=z onmouseover=alert(1) <b>"'</b>`;

/**
 * The tags and attribute names `html` holds, in order: its structure, not
 * its text. Read by its tokens, as the HTML standard's tokenizer reads them
 * (`htmlTokens`): every tag counts, whatever a tree builder would do with
 * it where the placeholder lands.
 */
function markupShape(html: string): string {
  const parts: string[] = [];
  for (const t of htmlTokens(html)) {
    if (t.kind === "start") parts.push(`<${t.name} ${t.attrs.map((a) => a.name).join(" ")}>`);
    else if (t.kind === "end") parts.push(`</${t.name}>`);
    else if (t.kind === "comment") parts.push("<!---->");
    else if (t.kind === "doctype") parts.push("<!doctype>");
  }
  return parts.join("");
}

/**
 * Whether a slot sits where a verdict's escaped text can change the
 * markup: filled with plain text and with {@link SLOT_PROBE}, the
 * placeholder must parse to the same elements and attributes.
 */
function slotChangesMarkup(html: string): boolean {
  const fill = (value: string) => html.replace(SLOT_RE, () => value);
  return markupShape(fill("x")) !== markupShape(fill(escapePluginText(SLOT_PROBE)));
}

const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(["https", "http", "mailto", "tel"]);

/** The rule a placeholder `href` breaks, or null. Relative, fragment and the page link schemes pass. */
function hrefProblem(href: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000- \u007f"'<>`\\]/.test(href)) return "href-characters";
  if (href.startsWith("//")) return "href-protocol-relative";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return null;
  return ALLOWED_LINK_SCHEMES.has(scheme) ? null : `href-scheme-${scheme}`;
}

/**
 * The rule a placeholder's markup breaks, or null. Parsed with entities
 * decoded, so `jav&#97;script:` is seen as what a browser would follow.
 */
export function placeholderMarkupProblem(html: string): string | null {
  if (FOREIGN_TEMPLATE_RE.test(html)) {
    return "template-syntax: only {{name}} slots are allowed";
  }
  if (slotChangesMarkup(html)) {
    return "a {{slot}} outside text and quoted attribute values: a verdict's text could add attributes or elements there — put each slot in text or in a quoted attribute value";
  }
  // Read by its tokens, as the HTML standard's tokenizer reads them: every
  // start and end tag is held to the rules, whatever a tree builder would
  // do with it (a `<td onfocus=…>` is a cell where the placeholder sits in
  // a table; a `<body onload=…>` gives the page's body its handler). A
  // marker of letters after the markup must be the last text: after an
  // unfinished tag or an unclosed comment, the page's own markup that
  // follows the placeholder would land inside it.
  let mark = "qzxend";
  while (html.toLowerCase().includes(mark)) mark += "q";
  const tokens = htmlTokens(`${html}${mark}`);
  for (const t of tokens) {
    if (t.kind === "comment") {
      if (html.startsWith("<?", t.start)) return "processing instruction";
      if (t.data.includes("<")) return LT_PROBLEM;
      continue;
    }
    if (t.kind === "doctype") return "doctype";
    if (t.kind === "end") {
      if (!PLACEHOLDER_ELEMENTS.has(t.name)) return `element </${t.name}>`;
      continue;
    }
    if (t.kind !== "start") continue;
    if (!PLACEHOLDER_ELEMENTS.has(t.name)) return `element <${t.name}>`;
    for (const a of t.attrs) {
      const attr = a.name.toLowerCase();
      const allowed = PLACEHOLDER_ATTRIBUTES.has(attr) || /^(data|aria)-[a-z0-9-]+$/.test(attr);
      if (!allowed) return `attribute ${attr} on <${t.name}>`;
      // As written: `&lt;` stays text in raw text too.
      if (a.source.includes("<")) return LT_PROBLEM;
      if (attr === "href" && a.value.includes("{{"))
        return "a {{slot}} inside href: a verdict's text never chooses where a link goes";
      if (attr === "href") {
        const problem = hrefProblem(a.value);
        if (problem !== null) return problem;
      }
    }
  }
  const last = tokens[tokens.length - 1];
  if (last?.kind !== "text" || !last.value.endsWith(mark)) {
    return "the markup does not end in element content (an unfinished tag or an unclosed comment): close it";
  }
  return null;
}

/** The functions whose string arguments a browser takes as URLs. */
const URL_FUNCTIONS: ReadonlySet<string> = new Set([
  "url",
  "src",
  "image",
  "-webkit-image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
]);

/**
 * The rule a stylesheet breaks by loading something, or null. Read token
 * by token as the browser reads it (`css-tokens.ts`): a comment inside a
 * string hides nothing, and every escape is decoded once.
 *
 * @param allowedOrigin whether a `url()` may name this origin (`https://host`),
 *   for a client file the grant's `img`, `font` and `style` origins; a
 *   placeholder allows none.
 */
export function cssLoadProblem(
  css: string,
  allowedOrigin: (origin: string) => boolean = () => false,
): string | null {
  // The HTML parser ends a <style> element before any CSS is read.
  if (/<\/style/i.test(css)) return "</style";
  const tokens = cssTokens(css);
  // The innermost open function (or "" for a plain parenthesis).
  const open: string[] = [];
  for (const [k, t] of tokens.entries()) {
    const next = tokens[k + 1]?.kind === "ws" ? tokens[k + 2] : tokens[k + 1];
    let target: string | null = null;
    switch (t.kind) {
      case "at":
        if (t.name.toLowerCase() === "import") return "@import";
        break;
      case "function": {
        const name = t.name.toLowerCase();
        if (name === "expression") return "expression()";
        open.push(name);
        break;
      }
      case "ident": {
        const name = t.value.toLowerCase();
        if (name === "-moz-binding") return "binding";
        if (name === "behavior" && next?.kind === "delim" && next.value === ":") return "binding";
        if (name === "expression" && next?.kind === "delim" && next.value === "(") {
          return "expression()";
        }
        break;
      }
      case "delim":
        if (t.value === "(") open.push("");
        else if (t.value === ")") open.pop();
        break;
      case "url":
        if (t.bad) return `url(${t.value})`;
        target = t.value;
        break;
      case "string": {
        const value = asUrlInput(t.value);
        // A string a browser takes as a URL: an argument of url(), image-set(), …;
        // anywhere else, one that names a host (`\` counts as `/` in an http(s) URL).
        if (
          URL_FUNCTIONS.has(open.at(-1) ?? "") ||
          /^(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}/i.test(value)
        ) {
          target = t.value;
        }
        break;
      }
    }
    if (target === null) continue;
    const url = asUrlInput(target);
    if (url === "" || /^data:/i.test(url) || url.startsWith("#")) continue;
    if (cssUrlLoads(url, allowedOrigin)) return `url(${url})`;
  }
  return null;
}

/** A stylesheet's URLs resolve against this stand-in for the page's own origin. */
const CSS_BASE = new URL("https://plugin-stylesheet.invalid/assets/");

/**
 * `target` as the URL parser reads it: ASCII tabs and newlines removed,
 * leading and trailing C0 controls and spaces trimmed.
 */
function asUrlInput(target: string): string {
  return (
    target
      .replace(/[\t\n\r]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser trims them.
      .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
  );
}

/**
 * Whether a stylesheet URL `target` makes a request `allowedOrigin` does not
 * admit. Resolved the way the browser resolves it, so `/\\host/x`,
 * `\\\\host` and `https:\\\\host` name the host they reach: a target is
 * relative only when it stays on the stylesheet's own origin and names no
 * scheme; anything else must be an allowed `https` origin.
 */
function cssUrlLoads(target: string, allowedOrigin: (origin: string) => boolean): boolean {
  let url: URL;
  try {
    url = new URL(target, CSS_BASE);
  } catch {
    return true;
  }
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(target);
  if (!scheme && url.origin === CSS_BASE.origin) return false;
  return url.protocol !== "https:" || !allowedOrigin(url.origin);
}

/** One problem with a plugin's deferral placeholders, as validateManifest reports it. */
export interface ClientAssetProblem {
  readonly where: string;
  readonly problem: string;
}

/** Every problem of a manifest's `deferralPlaceholders`. */
export function deferralPlaceholderProblems(
  placeholders: Readonly<Record<string, { readonly html: string; readonly css: string }>>,
): ClientAssetProblem[] {
  const out: ClientAssetProblem[] = [];
  for (const [name, p] of Object.entries(placeholders)) {
    const markup = placeholderMarkupProblem(p.html);
    if (markup) out.push({ where: `deferralPlaceholders.${name}.html`, problem: markup });
    const css = cssLoadProblem(p.css);
    if (css) out.push({ where: `deferralPlaceholders.${name}.css`, problem: css });
  }
  return out;
}
