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

import { escapePluginText } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";

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

/** The elements and attribute names `html` parses to, in order: its structure, not its text. */
function markupShape(html: string): string {
  const parts: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        parts.push(`<${name} ${Object.keys(attributes).join(" ")}>`);
      },
      onclosetag(name) {
        parts.push(`</${name}>`);
      },
      oncomment() {
        parts.push("<!---->");
      },
      onprocessinginstruction(name) {
        parts.push(`<?${name}>`);
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
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
  let problem: string | null = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (problem !== null) return;
        if (!PLACEHOLDER_ELEMENTS.has(name)) {
          problem = `element <${name}>`;
          return;
        }
        for (const [attr, value] of Object.entries(attributes)) {
          const allowed = PLACEHOLDER_ATTRIBUTES.has(attr) || /^(data|aria)-[a-z0-9-]+$/.test(attr);
          if (!allowed) problem = `attribute ${attr} on <${name}>`;
          else if (attr === "href" && value.includes("{{"))
            problem = "a {{slot}} inside href: a verdict's text never chooses where a link goes";
          else if (attr === "href") problem = hrefProblem(value);
          if (problem !== null) return;
        }
      },
      onprocessinginstruction() {
        problem ??= "processing instruction";
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return problem;
}

/**
 * `css` without its closed comments, in one pass. A regex `/\/\*[\s\S]*?\*\//g`
 * rescans to the end from every `/*` when none closes: quadratic on a
 * stylesheet a plugin author controls. An unclosed comment is kept, so the
 * rules below still read it.
 */
function withoutCssComments(css: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = css.indexOf("/*", at);
    const close = open === -1 ? -1 : css.indexOf("*/", open + 2);
    if (close === -1) return out + css.slice(at);
    out += css.slice(at, open);
    at = close + 2;
  }
}

/** CSS with comments removed and escapes decoded, lowercased: what a browser's tokenizer sees. */
function normalisedCss(css: string): string {
  return withoutCssComments(css)
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, "$1")
    .toLowerCase();
}

/**
 * The rule a stylesheet breaks by loading something, or null.
 *
 * @param allowedOrigin whether a `url()` may name this origin (`https://host`),
 *   for a client file the grant's `img`, `font` and `style` origins; a
 *   placeholder allows none.
 */
export function cssLoadProblem(
  css: string,
  allowedOrigin: (origin: string) => boolean = () => false,
): string | null {
  const text = normalisedCss(css);
  if (/@import\b/.test(text)) return "@import";
  if (/expression\s*\(/.test(text)) return "expression()";
  if (/-moz-binding|behavior\s*:/.test(text)) return "binding";
  if (/<\/style/.test(text)) return "</style";
  for (const m of text.matchAll(/(?:url|image-set|image|src)\s*\(\s*(['"]?)([^'")]*)\1/g)) {
    const target = (m[2] as string).trim();
    if (target === "" || target.startsWith("data:") || target.startsWith("#")) continue;
    if (target.startsWith("//")) return `url(${target})`;
    const scheme = /^([a-z][a-z0-9+.-]*):/.exec(target)?.[1];
    if (scheme === undefined) continue;
    if (scheme !== "https") return `url(${target})`;
    let origin: string;
    try {
      origin = new URL(target).origin;
    } catch {
      return `url(${target})`;
    }
    if (!allowedOrigin(origin)) return `url(${target})`;
  }
  // A string a browser takes as a URL without url(): `image-set("…" 1x)`.
  for (const m of text.matchAll(/(['"])((?:[a-z][a-z0-9+.-]*:)?\/\/[^'"]*)\1/g)) {
    const target = m[2] as string;
    let origin: string | null = null;
    try {
      origin = target.startsWith("https://") ? new URL(target).origin : null;
    } catch {
      origin = null;
    }
    if (origin === null || !allowedOrigin(origin)) return `url(${target})`;
  }
  return null;
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
