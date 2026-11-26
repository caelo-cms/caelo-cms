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

import { Parser } from "htmlparser2";
import { type FieldDef, validateFieldValue } from "./fields.js";
import type { ListItem } from "./items.js";
import type { ListTypeDef, NodeDef } from "./list-type.js";

// ─── The checks (docs/dev/external-plugin-brokers.md §4.5) ──────────────
//
// Every composition point that hands a page values (list sources, list
// overlays, content variants) runs them through {@link checkPluginValue},
// for every plugin, shipped or installed (decision Q2 A):
//
// - `text`, `select`, `icon`: HTML-escaped. A plugin value is data, never
//   markup.
// - `link`: a scheme of `https:`, `http:`, `mailto:` or `tel:` (or an
//   internal `caelo:` reference, which the link resolver checks), never
//   protocol-relative (`//host`), and none of the characters that end an
//   attribute.
// - `richtext`: prose only. Parsed with htmlparser2 and refused (never
//   cleaned: a cleaned value would be a silent fallback, CLAUDE.md §2) on
//   an element outside {@link PROSE_ELEMENTS}, an `on*` or `style`
//   attribute, or a URL attribute the link rule refuses.
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

/** Escape text for HTML content and attribute values alike. */
export function escapePluginText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

/**
 * `value` as a browser reads it in a double-quoted attribute: character
 * references decoded by the HTML rules for attributes (`&#58` without a
 * semicolon is decoded, `&copy=` is not). Called only with a value that
 * holds no quote or `<`, so it cannot end the attribute it is parsed in.
 */
function asAttributeValue(value: string): string {
  let read: string | null = null;
  const parser = new Parser(
    {
      onattribute(name, decoded) {
        if (name === "href" && read === null) read = decoded;
      },
    },
    { decodeEntities: true },
  );
  parser.write(`<a href="${value}">`);
  parser.end();
  return read ?? value;
}

/**
 * The rule a richtext value breaks, or null when it is prose. The parser
 * decodes entities in attributes, so `jav&#97;script:` is seen as what a
 * browser would run.
 */
export function richtextProblem(html: string): string | null {
  let problem: string | null = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (problem !== null) return;
        if (!PROSE_ELEMENTS.has(name)) {
          problem = `element-${name}`;
          return;
        }
        for (const [attr, value] of Object.entries(attributes)) {
          if (attr.startsWith("on")) problem = `attribute-${attr}`;
          else if (attr === "style") problem = "attribute-style";
          else if (URL_ATTRIBUTES.has(attr)) problem = decodedUrlProblem(value);
          if (problem !== null) return;
        }
      },
      onprocessinginstruction() {
        problem ??= "processing-instruction";
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return problem;
}

/**
 * Check one value a plugin returned for `field`. The value has already
 * passed the field's shape check (`validateFieldValue`); this decides
 * whether it may reach a page, and in which form.
 */
export function checkPluginValue(field: FieldDef, value: unknown): PluginValueCheck {
  if (value === undefined || value === null) return { ok: true, value };
  switch (field.type) {
    case "text":
    case "select":
    case "icon":
      return typeof value === "string"
        ? { ok: true, value: escapePluginText(value) }
        : { ok: true, value };
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
      if (problem !== null) return { ok: false, rule: problem };
      // `target` reaches its attribute as written too (`{{field.target}}`).
      const target = typeof value === "object" ? (value as { target?: unknown }).target : undefined;
      return typeof target === "string"
        ? { ok: true, value: { ...(value as object), target: escapePluginText(target) } }
        : { ok: true, value };
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
      values[name] = checked.ok ? checked.value : refuse(checked.rule);
    }
    return {
      ...item,
      values,
      ...(item.children ? { children: item.children.map(visit) } : {}),
    };
  };
  return items.map(visit);
}
