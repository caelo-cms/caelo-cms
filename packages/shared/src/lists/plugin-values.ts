// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the values a plugin hands a page, checked before they reach it
 * (docs/dev/external-plugin-brokers.md §4.5; the head vocabulary of §6.2 is
 * the plugin host's `head-vocabulary.ts`), and what a refused one becomes.
 * `<source>` is a list source's name, {@link PLUGIN_HEAD_POINT} or
 * {@link PLUGIN_SHARE_IMAGES_POINT}. The refused value is replaced by
 * {@link refusedPluginValue}, so the render keeps the spot raw and records
 * `plugin-value-refused:<plugin>.<source>.<field>:<rule>`, a render failure
 * in the #1604 sense: the preview lists it, a Stage ships the spot raw and
 * records it, and Publish live refuses the build. A refusal is never a
 * cleaned value (CLAUDE.md §2, no fallbacks).
 */

import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as H, parseFragment } from "parse5";
import { htmlTokens } from "../html-tokens.js";
import { type FieldDef, validateFieldValue } from "./fields.js";
import type { ListItem } from "./items.js";
import type { ListTypeDef, NodeDef } from "./list-type.js";

// ─── The checks (docs/dev/external-plugin-brokers.md §4.5) ──────────────
//
// Every composition point that hands a page values (list sources, list
// overlays, content variants) runs them through {@link checkPluginValue},
// for every plugin, shipped or installed (decision Q2 A):
//
// - `text`, `select`, `icon`: data, never markup. They keep their raw
//   text here and are escaped where they are substituted, by the context of
//   their placeholder in the module HTML ({@link contextualPluginValue},
//   `template-contexts.ts`): HTML-escaped in text and attributes, held to
//   the link rule in a URL attribute, refused in an event handler, a
//   `style` attribute, `srcdoc` or a `<script>` / `<style>` body.
// - `link`: a scheme of `https:`, `http:`, `mailto:` or `tel:` (or an
//   internal `caelo:` reference, which the link resolver checks), never
//   protocol-relative (`//host`), and none of the characters that end an
//   attribute.
// - `richtext`: prose only. Parsed as a browser parses it (parse5) and refused (never
//   cleaned: a cleaned value would be a silent fallback, CLAUDE.md §2) on
//   an element outside {@link PROSE_ELEMENTS}, an `on*` or `style`
//   attribute, a URL attribute the link rule refuses, or an end that is
//   not element content (an unfinished tag, an unclosed comment): the
//   module's own markup after it would land inside.
// - `media`: `caelo:media/<id>` of an image in the library (not a
//   reference image); {@link checkPluginMedia} takes what the media table
//   says of the ids (the plugin host reads it, `describePluginMedia`).
//
// A refusal names the rule (`element-script`, `attribute-onerror`,
// `url-scheme`, …), which becomes the `plugin-value-refused` render
// failure with the field it was in.

/** A checked value: what the page may show, or the rule it broke. */
export type PluginValueCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly rule: string };

/** Elements a plugin's richtext may contain: inline and block prose, nothing that loads or runs. */
export const PROSE_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "a",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "code",
  "br",
  "span",
]);

/** Attributes whose value is a URL, held to the link rule wherever they appear. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "src",
  "srcset",
  "cite",
  "action",
  "formaction",
  "poster",
  "background",
  "xlink:href",
]);

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["https:", "http:", "mailto:", "tel:"]);

/** Whether `scheme` (without its colon, any case) is one a page may link with, or an internal `caelo:` reference. */
export function isLinkScheme(scheme: string): boolean {
  const s = scheme.toLowerCase();
  return s === "caelo" || ALLOWED_SCHEMES.has(`${s}:`);
}

/** Escape text for HTML content and quoted attribute values alike. */
export function escapePluginText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Escape text for an unquoted attribute value (`title={{label}}`), where
 * whitespace would end the value and `=` or a backtick would start another
 * one. Character references are decoded in an unquoted value, so the text
 * arrives whole; an empty one is written `""`, which keeps the next
 * attribute from becoming the value.
 */
export function escapeUnquotedPluginText(text: string): string {
  if (text.length === 0) return '""';
  return escapePluginText(text)
    .replaceAll("=", "&#61;")
    .replaceAll("`", "&#96;")
    .replace(/[\t\n\f\r ]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The link rule: the rule a URL breaks, or null when it may reach a page.
 * Relative URLs (`/path`, `#anchor`, `?q`) and internal `caelo:` references
 * pass; whitespace, control characters and attribute-ending characters
 * never do, so `java\tscript:` or `"onmouseover=` cannot slip through.
 *
 * A link value reaches its attribute as written, and a browser decodes
 * character references there: `javascript&#58;alert(1)` is
 * `javascript:alert(1)` to it. So the rule holds for the value as written
 * and as the browser reads it.
 */
export function urlProblem(url: string): string | null {
  const written = decodedUrlProblem(url);
  if (written !== null || !url.includes("&")) return written;
  return decodedUrlProblem(asAttributeValue(url));
}

/** {@link urlProblem} for a URL whose character references are already decoded. */
function decodedUrlProblem(url: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000- \u007f"'<>`\\]/.test(url)) return "url-characters";
  if (url.startsWith("//")) return "url-protocol-relative";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1];
  if (scheme === undefined) return null;
  if (scheme.toLowerCase() === "caelo") return null;
  return ALLOWED_SCHEMES.has(`${scheme.toLowerCase()}:`) ? null : "url-scheme";
}

/** `html` as a `<body>`'s content, read the way a browser with scripting on reads it. */
function parseBody(html: string, locations = false): DefaultTreeAdapterTypes.DocumentFragment {
  const body = defaultTreeAdapter.createElement("body", H.NS.HTML, []);
  return parseFragment(body, html, { scriptingEnabled: true, sourceCodeLocationInfo: locations });
}

/**
 * `value` as a browser reads it in a double-quoted attribute: character
 * references decoded by the HTML rules for attributes (`&#58` without a
 * semicolon is decoded, `&copy=` is not). Called only with a value that
 * holds no quote or `<`, so it cannot end the attribute it is parsed in.
 */
function asAttributeValue(value: string): string {
  const a = parseBody(`<a href="${value}">`).childNodes[0];
  const href = a && "attrs" in a ? a.attrs.find((x) => x.name === "href") : undefined;
  return href?.value ?? value;
}

/** Letters `html` does not hold, so they mark where it ends. */
function endMarker(html: string): string {
  const lower = html.toLowerCase();
  for (let n = 0; ; n += 1) {
    const mark = `qzxend${n.toString(36)}zq`;
    if (!lower.includes(mark)) return mark;
  }
}

/** How deep a richtext's elements may nest: prose never needs more, and a check must never run out of stack. */
export const MAX_RICHTEXT_DEPTH = 256;

/** Prose elements without content: they open nothing. */
const VOID_PROSE = new Set(["br"]);

/**
 * The rule a richtext value breaks, or null when it is prose. Read by its
 * tokens, as the HTML standard's tokenizer reads them (`htmlTokens`), so
 * every start and end tag is held to {@link PROSE_ELEMENTS} and every
 * attribute to the attribute rules, whatever a tree builder would do with
 * it: a `<td onfocus=…>` is dropped by a body-content parse but is a cell
 * of the table the module puts the value in, and a `<body onload=…>` gives
 * the page's own body its handler. Attribute values are decoded, so
 * `jav&#97;script:` is seen as what a browser would run.
 *
 * The richtext must end in element content: a marker of letters after it
 * must be the last text. After an unfinished tag (`<p onclick=…`, a
 * trailing `<` or `<di`) the tokenizer drops the marker with the tag, and
 * in an unclosed comment it is the comment's; the module's own markup after
 * the value would land there. Nesting past {@link MAX_RICHTEXT_DEPTH} is
 * refused: no check walks a tree it builds from a plugin's value.
 */
export function richtextProblem(html: string): string | null {
  const mark = endMarker(html);
  const tokens = htmlTokens(`${html}${mark}`);
  const open: string[] = [];
  for (const t of tokens) {
    if (t.kind === "start") {
      if (!PROSE_ELEMENTS.has(t.name)) return `element-${t.name}`;
      for (const a of t.attrs) {
        const attr = a.name.toLowerCase();
        if (attr.startsWith("on")) return `attribute-${attr}`;
        if (attr === "style") return "attribute-style";
        if (URL_ATTRIBUTES.has(attr)) {
          const problem = decodedUrlProblem(a.value);
          if (problem !== null) return problem;
        }
      }
      if (!VOID_PROSE.has(t.name)) {
        open.push(t.name);
        if (open.length > MAX_RICHTEXT_DEPTH) return "richtext-too-deep";
      }
    } else if (t.kind === "end") {
      // An end tag of anything else closes an element of the module (a `</select>`, a `</svg>`).
      if (!PROSE_ELEMENTS.has(t.name)) return `end-tag-${t.name}`;
      const at = open.lastIndexOf(t.name);
      if (at !== -1) open.length = at;
    } else if (t.kind === "comment") {
      if (html.startsWith("<?", t.start)) return "processing-instruction";
    } else if (t.kind === "doctype") {
      return "doctype";
    }
  }
  const last = tokens[tokens.length - 1];
  if (last?.kind !== "text" || !last.value.endsWith(mark)) return "richtext-unfinished";
  return null;
}

/**
 * Check one value a plugin returned for `field`. The value has already
 * passed the field's shape check (`validateFieldValue`); this decides
 * whether it may reach a page, and in which form. It never throws: a value
 * a check cannot read is refused (`value-unreadable`), a render failure
 * that blocks Publish live, never an error that stops a Stage.
 */
export function checkPluginValue(field: FieldDef, value: unknown): PluginValueCheck {
  try {
    return checkValue(field, value);
  } catch {
    return { ok: false, rule: "value-unreadable" };
  }
}

function checkValue(field: FieldDef, value: unknown): PluginValueCheck {
  if (value === undefined || value === null) return { ok: true, value };
  switch (field.type) {
    case "text":
    case "select":
    case "icon":
      // Escaped where it is substituted, by its placeholder's context.
      return { ok: true, value };
    case "richtext": {
      if (typeof value !== "string") return { ok: true, value };
      const problem = richtextProblem(value);
      return problem === null ? { ok: true, value } : { ok: false, rule: problem };
    }
    case "link": {
      const href =
        typeof value === "string"
          ? value
          : typeof value === "object" && typeof (value as { href?: unknown }).href === "string"
            ? (value as { href: string }).href
            : null;
      if (href === null) return { ok: true, value };
      const problem = urlProblem(href);
      return problem === null ? { ok: true, value } : { ok: false, rule: problem };
    }
    default:
      return { ok: true, value };
  }
}

/** The media id of a `caelo:media/<id>` value, or null for any other value. */
export function pluginMediaId(value: unknown): string | null {
  return typeof value === "string"
    ? (/^caelo:media\/([0-9a-f-]{36})(?:\/[a-z0-9-]+)?$/.exec(value)?.[1] ?? null)
    : null;
}

/** What the host knows of a media asset a plugin value names. */
export interface PluginMediaFacts {
  readonly visibility: "library" | "reference";
  readonly mime: string;
}

/**
 * The rule a media value breaks, given what the media table says of the
 * ids the answer names (`facts`, from {@link describePluginMedia}), or
 * null when it is an image of the library.
 */
export function checkPluginMedia(
  value: unknown,
  facts: ReadonlyMap<string, PluginMediaFacts>,
): string | null {
  const id = pluginMediaId(value);
  if (id === null) return null;
  const asset = facts.get(id);
  if (!asset) return "media-missing";
  if (asset.visibility !== "library") return "media-reference";
  return asset.mime.startsWith("image/") ? null : "media-not-image";
}

/** Marker kind of a plugin value the host refused. */
export const PLUGIN_VALUE_REFUSED = "plugin-value-refused";

/**
 * #1729 — the `<source>` of a refusal from the head-contribution point
 * (head entries, sitemap adjustments, the document language): not a list
 * source, which is snake_case and never holds a hyphen.
 */
export const PLUGIN_HEAD_POINT = "head-composition";

/** #1729 — the `<source>` of a refused default share image (field `image`). */
export const PLUGIN_SHARE_IMAGES_POINT = "share-images";

/** The key of a refused value's stand-in; a plugin entry value can never be an object with it. */
const REFUSED_KEY = "$caeloRefused";

/** The marker of a refused value: which plugin, source and field, and the rule it broke. */
export function pluginValueRefusedMarker(
  plugin: string,
  source: string,
  field: string,
  rule: string,
): string {
  return `${PLUGIN_VALUE_REFUSED}:${plugin}.${source}.${field}:${rule}`;
}

/** The stand-in a refused value is replaced by; JSON, so it crosses a build's process boundary. */
export function refusedPluginValue(marker: string): { readonly $caeloRefused: string } {
  return { [REFUSED_KEY]: marker } as { readonly $caeloRefused: string };
}

/** The marker of a refused value's stand-in, or null for any other value. */
export function refusedPluginValueMarker(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const marker = (value as Record<string, unknown>)[REFUSED_KEY];
  return typeof marker === "string" ? marker : null;
}

/** The parts of a `plugin-value-refused` marker's body (what follows the kind). */
export function parsePluginValueRefused(body: string): {
  readonly plugin: string;
  readonly source: string;
  readonly field: string;
  readonly rule: string;
} {
  const at = body.lastIndexOf(":");
  const where = at < 0 ? body : body.slice(0, at);
  const [plugin = "", source = "", field = ""] = where.split(".");
  return { plugin, source, field, rule: at < 0 ? "" : body.slice(at + 1) };
}

/** The key of a plugin-owned local list (see {@link pluginLocalList}). */
const PLUGIN_LIST_KEY = "$caeloPluginList";

/** Who handed a placement a local list, and the media facts its answer named. */
export interface PluginListOwner {
  readonly plugin: string;
  /** Where the list sits (`<placement>/<field>`), named in a refusal. */
  readonly address: string;
  readonly media?: Readonly<Record<string, PluginMediaFacts>>;
}

/**
 * #1729 (§4.5) — a local list's entries a plugin handed a placement (a
 * content variant), wrapped so the list resolver checks each value against
 * its field where the list renders and its list type is known: text
 * escaped, richtext prose, links to the link rule, media to library
 * images. JSON, so it crosses a build's process boundary.
 */
export function pluginLocalList(owner: PluginListOwner, entries: unknown): unknown {
  return { [PLUGIN_LIST_KEY]: owner, entries };
}

/** The owner and entries of a {@link pluginLocalList}, or null for any other value. */
export function pluginLocalListOf(
  value: unknown,
): { readonly owner: PluginListOwner; readonly entries: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const owner = (value as Record<string, unknown>)[PLUGIN_LIST_KEY];
  if (typeof owner !== "object" || owner === null) return null;
  return { owner: owner as PluginListOwner, entries: (value as { entries?: unknown }).entries };
}

/**
 * A plugin's local list entries, each value held to its field of `type`:
 * first its shape (`validateFieldValue`, which no write checked), then the
 * §4.5 rule. A refused value becomes its stand-in (it renders raw and
 * fails), a value of a field the node does not declare too.
 */
export function checkPluginListEntries(
  type: ListTypeDef,
  items: readonly ListItem[],
  owner: PluginListOwner,
): ListItem[] {
  const media = new Map(Object.entries(owner.media ?? {}));
  const visit = (item: ListItem): ListItem => {
    const node = type.nodes[item.node] as NodeDef;
    const values: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(item.values)) {
      const field = node.fields.find((f) => f.name === name);
      const refuse = (rule: string) =>
        refusedPluginValue(
          pluginValueRefusedMarker(
            owner.plugin,
            "content-variants",
            `${owner.address}/item/${item.id}/${name}`,
            rule,
          ),
        );
      if (field === undefined) {
        values[name] = refuse("undeclared-field");
        continue;
      }
      if (validateFieldValue({ ...field, required: false }, value, name).length > 0) {
        values[name] = refuse(`type-${field.type}`);
        continue;
      }
      const mediaRule = field.type === "media" ? checkPluginMedia(value, media) : null;
      const checked = mediaRule
        ? ({ ok: false, rule: mediaRule } as const)
        : checkPluginValue(field, value);
      values[name] = checked.ok
        ? pluginValue(
            {
              plugin: owner.plugin,
              point: "content-variants",
              address: `${owner.address}/item/${item.id}/${name}`,
              type: field.type,
            },
            checked.value,
          )
        : refuse(checked.rule);
    }
    return {
      ...item,
      values,
      ...(item.children ? { children: item.children.map(visit) } : {}),
    };
  };
  return items.map(visit);
}

// ─── Plugin values in a module's HTML ──────────────────────────────────

/** The key of a plugin-owned value (see {@link pluginValue}). */
const PLUGIN_VALUE_KEY = "$caeloPluginValue";

/** Whose value it is and where it came from, as a refusal names it. */
export interface PluginValueOrigin {
  readonly plugin: string;
  /** The composition point or list source (`content-variants`, `list-resolve`, a source name). */
  readonly point: string;
  /** The field it fills (`layout:footer:0/title`, an overlay address, `<entry>/<field>`). */
  readonly address: string;
  /** The field type it was checked as (`text`, `richtext`, `link`, `media`, …). */
  readonly type: string;
}

/**
 * #1729 (§4.5) — a value a plugin handed a page, checked for its field and
 * still raw: the template engine escapes or refuses it where it is
 * substituted, by the context of its placeholder (`template-contexts.ts`,
 * {@link contextualPluginValue}). JSON, so it crosses a build's process
 * boundary.
 */
export function pluginValue(origin: PluginValueOrigin, value: unknown): unknown {
  return { [PLUGIN_VALUE_KEY]: origin, value };
}

/** The origin and raw value of a {@link pluginValue}, or null for any other value. */
export function pluginValueOf(
  value: unknown,
): { readonly origin: PluginValueOrigin; readonly value: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const origin = (value as Record<string, unknown>)[PLUGIN_VALUE_KEY];
  if (typeof origin !== "object" || origin === null) return null;
  return { origin: origin as PluginValueOrigin, value: (value as { value?: unknown }).value };
}

/**
 * Where a placeholder sits in a module's HTML, as far as a plugin's value
 * is concerned (`template-contexts.ts` works it out once per template).
 *
 * - `text`: element content, a comment, `<title>` or `<textarea>`;
 * - `attribute`: a value of an attribute that is neither a URL nor code;
 * - `url`: a URL attribute's value. `whole`: the placeholder decides the
 *   URL's scheme; `path`: the template's text before it already did;
 *   `composed`: the scheme would be made of the placeholder and other
 *   parts, which no single value can be held to;
 * - `refused`: an event handler, a `style` attribute, `srcdoc`, a
 *   `<script>` or `<style>` body, a tag's name or an attribute's name:
 *   places where any value is code or markup.
 */
export type PlaceholderContext =
  /** `markup`: element content, where markup is parsed; false in a comment or a text-only element. */
  | { readonly kind: "text"; readonly markup: boolean }
  | { readonly kind: "attribute"; readonly quoted: boolean }
  | {
      readonly kind: "url";
      readonly quoted: boolean;
      readonly position: "whole" | "path" | "composed";
      /** The template's text right before the value ends in `/`: a value starting with `/` or `\` would make `//host`. */
      readonly afterSlash: boolean;
    }
  | { readonly kind: "refused"; readonly rule: string };

/**
 * The characters a URL a plugin fills part of may not hold, as written or
 * as decoded in its attribute: whitespace and control characters (a URL
 * parser strips some, and they end an unquoted value), and the characters
 * that end an attribute.
 */
function urlCharactersProblem(url: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  const bad = /[\u0000- \u007f"'<>`\\]/;
  if (bad.test(url)) return "url-characters";
  return url.includes("&") && bad.test(asAttributeValue(url)) ? "url-characters" : null;
}

/**
 * A plugin's value as it may stand at a placeholder of `context`: the
 * HTML to substitute, or the rule it breaks there (which the engine records
 * as `plugin-value-refused:<plugin>.<point>.<address>:<rule>` and keeps the
 * placeholder raw).
 *
 * - text: richtext is prose (checked already) and stays markup in element
 *   content; in a comment or a text-only element (`<title>`, `<textarea>`)
 *   it is escaped like every other value, so `-->` closes nothing;
 * - attribute: escaped (richtext too: an attribute holds no markup),
 *   unquoted with {@link escapeUnquotedPluginText};
 * - URL: held to the link rule when it decides the URL, to the URL
 *   characters when the template's text before it did; never composed.
 *   Its `&` is written `&amp;`, so the value can start no character
 *   reference with the template's text after it (`javascript&` before
 *   `#58;…`): the browser reads the URL exactly as checked;
 * - refused: every plugin value, whatever it says.
 */
export function contextualPluginValue(
  context: PlaceholderContext,
  origin: PluginValueOrigin,
  value: string,
): { readonly ok: true; readonly html: string } | { readonly ok: false; readonly rule: string } {
  switch (context.kind) {
    case "refused":
      return { ok: false, rule: context.rule };
    case "text": {
      if (origin.type !== "richtext" || !context.markup) {
        return { ok: true, html: escapePluginText(value) };
      }
      // Markup where it lands: held to the prose rules here too, whichever
      // path brought it (the plugin host checked it already; this check
      // must not depend on that).
      const problem = richtextProblem(value);
      return problem === null ? { ok: true, html: value } : { ok: false, rule: problem };
    }
    case "attribute":
      return {
        ok: true,
        html: context.quoted ? escapePluginText(value) : escapeUnquotedPluginText(value),
      };
    case "url": {
      if (context.position === "composed") return { ok: false, rule: "url-composed" };
      if (context.afterSlash && /^[/\\]/.test(value)) {
        return { ok: false, rule: "url-protocol-relative" };
      }
      const problem =
        context.position === "whole" ? urlProblem(value) : urlCharactersProblem(value);
      if (problem !== null) return { ok: false, rule: problem };
      const html = value.replaceAll("&", "&amp;");
      return { ok: true, html: !context.quoted && html.length === 0 ? '""' : html };
    }
  }
}
