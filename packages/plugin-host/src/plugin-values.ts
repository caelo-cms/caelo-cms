// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — values a plugin hands a page (docs/dev/external-plugin-brokers.md
 * §4.5). The template engine substitutes values raw, so every composition
 * point that returns values (list sources, list overlays, content variants)
 * runs them through {@link checkPluginValue} first, for every plugin,
 * shipped or installed (decision Q2 A):
 *
 * - `text`, `select`, `icon`: HTML-escaped. A plugin value is data, never
 *   markup.
 * - `link`: the stored link shape, a scheme of `https:`, `http:`,
 *   `mailto:` or `tel:` (or an internal `caelo:` reference, which the link
 *   resolver checks), never protocol-relative (`//host`), and none of the
 *   characters that end an attribute.
 * - `richtext`: prose only. Parsed with htmlparser2 and refused (never
 *   cleaned: a cleaned value would be a silent fallback, CLAUDE.md §2) on
 *   an element outside {@link PROSE_ELEMENTS}, an `on*` or `style`
 *   attribute, or a URL attribute the link rule refuses.
 * - `media`: `caelo:media/<id>` of an image in the library (not a
 *   reference image); {@link checkPluginMedia} asks the media table.
 *
 * A refusal names the rule (`element-script`, `attribute-onerror`,
 * `url-scheme`, …), which becomes the `plugin-value-refused` render
 * failure (shared `lists/plugin-values.ts`) with the field it was in.
 */

import { execute, joinHeldTransaction } from "@caelo-cms/query-api";
import type { FieldDef } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";
import { hostInfra, hostSystemActorId } from "./dispatch.js";

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
 */
export function urlProblem(url: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000- \u007f"'<>`\\]/.test(url)) return "url-characters";
  if (url.startsWith("//")) return "url-protocol-relative";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1];
  if (scheme === undefined) return null;
  if (scheme.toLowerCase() === "caelo") return null;
  return ALLOWED_SCHEMES.has(`${scheme.toLowerCase()}:`) ? null : "url-scheme";
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
          else if (URL_ATTRIBUTES.has(attr)) problem = urlProblem(value);
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

/**
 * What the media table says of the ids one answer names, 1000 per read
 * (`media.describe_many`, O(ids)). Media is not branched, so a preview and
 * a build see the same facts.
 */
export async function describePluginMedia(
  ids: ReadonlyArray<string>,
): Promise<Map<string, PluginMediaFacts>> {
  const out = new Map<string, PluginMediaFacts>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const infra = hostInfra();
  for (let i = 0; i < unique.length; i += 1000) {
    // #1254 — render-time read work: it joins a transaction the caller holds
    // (an in-process build holds one) instead of taking a second connection.
    const r = await joinHeldTransaction(() =>
      execute(
        infra.registry,
        infra.adapter,
        { actorId: hostSystemActorId(), actorKind: "system", requestId: "plugin-values-media" },
        "media.describe_many",
        { ids: unique.slice(i, i + 1000) },
      ),
    );
    if (!r.ok) {
      throw new Error(
        `plugin values: the media check failed: ${"message" in r.error ? (r.error as { message: string }).message : r.error.kind}`,
      );
    }
    for (const a of (r.value as { assets: Array<{ id: string } & PluginMediaFacts> }).assets) {
      out.set(a.id, { visibility: a.visibility, mime: a.mime });
    }
  }
  return out;
}
