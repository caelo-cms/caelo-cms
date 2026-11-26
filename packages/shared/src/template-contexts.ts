// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (docs/dev/external-plugin-brokers.md §4.5) — where each `{{…}}` tag
 * of a module template sits in its HTML, for the value a plugin hands it.
 * Module HTML substitutes raw (CMS_REQUIREMENTS §3.1), so a value is safe
 * only for the place it lands: HTML-escaped text is safe in element content
 * and in a quoted attribute, but not in an event handler, and a URL needs
 * the link rule. The template engine asks {@link placeholderContextAt} for
 * a tag's place and `contextualPluginValue` (lists/plugin-values.ts)
 * decides what a plugin's value becomes there. Core values substitute as
 * they always have.
 *
 * Worked out once per template text: the tags are masked (each `{{…}}`
 * becomes as many `x`, so it reads as one opaque word and every offset
 * stays put), the masked HTML runs through htmlparser2's tokenizer, and
 * each tag takes the context of the span that holds it. The result is kept
 * for the most recent templates ({@link CONTEXT_CACHE_SIZE}); a render with
 * no plugin value never asks.
 */

import { QuoteType, Tokenizer } from "htmlparser2";
import type { PlaceholderContext } from "./lists/plugin-values.js";

/** Attributes whose value is a URL: a plugin's value there is held to the link rule. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "src",
  "srcset",
  "imagesrcset",
  "cite",
  "action",
  "formaction",
  "poster",
  "background",
  "xlink:href",
  "data",
  "ping",
  "longdesc",
  "usemap",
  "manifest",
  "codebase",
  "archive",
  "classid",
  "lowsrc",
  "dynsrc",
  "icon",
  "profile",
]);

/** SVG animation elements, whose `to`/`from`/`values`/`by` can set any attribute (an `href` to `javascript:`). */
const SVG_ANIMATION = new Set(["set", "animate", "animatetransform", "animatemotion"]);
const SVG_ANIMATION_ATTRIBUTES = new Set(["to", "from", "values", "by", "attributename"]);

/** How many templates' contexts are kept: enough for every module a build renders over and over. */
export const CONTEXT_CACHE_SIZE = 512;

/** One `{{…}}` tag: `[start, end)`, and whether it is a section tag (`#`, `^`, `/`), which carries no value. */
interface MustacheSpan {
  readonly start: number;
  readonly end: number;
  readonly section: boolean;
}

/** The contexts of one template, by the offset of a tag's `{{`. */
export interface PlaceholderContexts {
  readonly byStart: ReadonlyMap<number, PlaceholderContext>;
}

const cache = new Map<string, PlaceholderContexts>();

/** The contexts of `html`'s tags, worked out once and kept for the recent templates. */
export function placeholderContexts(html: string): PlaceholderContexts {
  const hit = cache.get(html);
  if (hit) {
    cache.delete(html);
    cache.set(html, hit);
    return hit;
  }
  const computed = computeContexts(html);
  cache.set(html, computed);
  if (cache.size > CONTEXT_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return computed;
}

/**
 * The context of the tag whose `{{` starts at `offset` in `html` (the
 * inner `{{` of a `{{{…}}}` included). A tag the template does not have
 * reads as markup: refused for a plugin's value, never guessed.
 */
export function placeholderContextAt(html: string, offset: number): PlaceholderContext {
  return (
    placeholderContexts(html).byStart.get(offset) ?? { kind: "refused", rule: "context-markup" }
  );
}

/** Every `{{…}}` / `{{{…}}}` tag of `html`, in order (linear: one `indexOf` pair per tag). */
function mustacheSpans(html: string): MustacheSpan[] {
  const out: MustacheSpan[] = [];
  let from = 0;
  for (;;) {
    const start = html.indexOf("{{", from);
    if (start === -1) break;
    const close = html.indexOf("}}", start + 2);
    if (close === -1) break;
    let end = close + 2;
    if (html[start + 2] === "{" && html[end] === "}") end += 1;
    const sigil = html.slice(start + 2, close).trimStart()[0];
    out.push({ start, end, section: sigil === "#" || sigil === "^" || sigil === "/" });
    from = end;
  }
  return out;
}

/** A span of the masked template and what a tag inside it is. */
interface Region {
  readonly start: number;
  readonly end: number;
  readonly context: (tag: MustacheSpan) => PlaceholderContext;
}

function refused(rule: string): () => PlaceholderContext {
  const context: PlaceholderContext = { kind: "refused", rule };
  return () => context;
}

const TEXT: PlaceholderContext = { kind: "text" };

function computeContexts(html: string): PlaceholderContexts {
  const tags = mustacheSpans(html);
  const byStart = new Map<number, PlaceholderContext>();
  if (tags.length === 0) return { byStart };
  let masked = "";
  let at = 0;
  for (const t of tags) {
    masked += html.slice(at, t.start) + "x".repeat(t.end - t.start);
    at = t.end;
  }
  masked += html.slice(at);

  const regions: Region[] = [];
  let element = "";
  let rawText: "script" | "style" | null = null;
  let attr: { name: string; start: number; end: number } | null = null;
  const name = (s: number, e: number) => masked.slice(s, e).toLowerCase();
  const tokenizer = new Tokenizer(
    { decodeEntities: false },
    {
      onopentagname(s, e) {
        element = name(s, e);
        regions.push({ start: s, end: e, context: refused("context-tag") });
      },
      onopentagend() {
        rawText = element === "script" || element === "style" ? element : null;
      },
      onselfclosingtag() {
        rawText = null;
      },
      onclosetag(s, e) {
        rawText = null;
        regions.push({ start: s, end: e, context: refused("context-tag") });
      },
      onattribname(s, e) {
        attr = { name: name(s, e), start: -1, end: -1 };
        regions.push({ start: s, end: e, context: refused("context-tag") });
      },
      onattribdata(s, e) {
        if (!attr) return;
        if (attr.start === -1) attr.start = s;
        attr.end = e;
      },
      onattribentity() {},
      onattribend(quote) {
        const a = attr;
        attr = null;
        if (!a || a.start === -1) return;
        const quoted = quote === QuoteType.Double || quote === QuoteType.Single;
        const owner = element;
        regions.push({
          start: a.start,
          end: a.end,
          context: (tag) => attributeContext(html, tags, owner, a, quoted, tag),
        });
      },
      ontext(s, e) {
        const kind = rawText;
        regions.push({
          start: s,
          end: e,
          context: kind === null ? () => TEXT : refused(`context-${kind}`),
        });
      },
      ontextentity() {},
      oncomment(s, e) {
        regions.push({ start: s, end: e, context: () => TEXT });
      },
      oncdata(s, e) {
        regions.push({ start: s, end: e, context: refused("context-markup") });
      },
      ondeclaration(s, e) {
        regions.push({ start: s, end: e, context: refused("context-markup") });
      },
      onprocessinginstruction(s, e) {
        regions.push({ start: s, end: e, context: refused("context-markup") });
      },
      onend() {},
    },
  );
  tokenizer.write(masked);
  tokenizer.end();

  regions.sort((a, b) => a.start - b.start);
  let r = 0;
  for (const tag of tags) {
    if (tag.section) continue;
    while (r < regions.length && (regions[r] as Region).end <= tag.start) r += 1;
    const region = regions[r];
    const context =
      region && region.start <= tag.start && tag.start < region.end
        ? region.context(tag)
        : ({ kind: "refused", rule: "context-markup" } as const);
    byStart.set(tag.start, context);
    // The inner `{{` of a `{{{…}}}`, where the section pass finds the tag.
    if (html[tag.start + 2] === "{") byStart.set(tag.start + 1, context);
  }
  return { byStart };
}

/** The context of `tag` inside the value of `attr` on `element`. */
function attributeContext(
  html: string,
  tags: readonly MustacheSpan[],
  element: string,
  attr: { readonly name: string; readonly start: number; readonly end: number },
  quoted: boolean,
  tag: MustacheSpan,
): PlaceholderContext {
  const n = attr.name;
  if (n.startsWith("on")) return { kind: "refused", rule: "context-event-handler" };
  if (n === "style") return { kind: "refused", rule: "context-style-attribute" };
  if (n === "srcdoc") return { kind: "refused", rule: "context-srcdoc" };
  if (element === "meta") return { kind: "refused", rule: "context-meta" };
  if (element === "base") return { kind: "refused", rule: "context-base" };
  if (SVG_ANIMATION.has(element) && SVG_ANIMATION_ATTRIBUTES.has(n)) {
    return { kind: "refused", rule: "context-svg-animation" };
  }
  if (!URL_ATTRIBUTES.has(n)) return { kind: "attribute", quoted };
  return { kind: "url", quoted, position: urlPosition(html, tags, attr, tag) };
}

/** A part of an attribute value: literal text, or a tag (a value tag, or a section tag that carries none). */
type Part =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly start: number }
  | { readonly kind: "section" };

/**
 * Whether `tag` decides the scheme of its URL attribute's value (`whole`),
 * comes after template text that already did (`path`: a `:`, `/`, `?` or
 * `#` before it), or shares the scheme with other parts (`composed`):
 * text or another value before it, or a `:` or another value after it
 * before the path begins. A `srcset` holds one URL per comma.
 */
function urlPosition(
  html: string,
  tags: readonly MustacheSpan[],
  attr: { readonly name: string; readonly start: number; readonly end: number },
  tag: MustacheSpan,
): "whole" | "path" | "composed" {
  const parts: Part[] = [];
  let at = attr.start;
  for (const t of tags) {
    if (t.end <= attr.start || t.start >= attr.end) continue;
    if (t.start > at) parts.push({ kind: "text", text: html.slice(at, t.start) });
    parts.push(t.section ? { kind: "section" } : { kind: "value", start: t.start });
    at = t.end;
  }
  if (at < attr.end) parts.push({ kind: "text", text: html.slice(at, attr.end) });
  const srcset = attr.name === "srcset" || attr.name === "imagesrcset";
  const index = parts.findIndex((p) => p.kind === "value" && p.start === tag.start);

  // Before: only what follows the last comma of a srcset counts.
  let literal = "";
  let valueBefore = false;
  for (const p of parts.slice(0, index)) {
    if (p.kind === "text") {
      const cut = srcset ? p.text.lastIndexOf(",") : -1;
      if (cut >= 0) {
        literal = p.text.slice(cut + 1);
        valueBefore = false;
      } else literal += p.text;
    } else if (p.kind === "value") valueBefore = true;
  }
  if (/[:/?#]/.test(literal)) return "path";
  if (valueBefore || literal.trim() !== "") return "composed";

  // After: up to where the path (or, in a srcset, the candidate) begins.
  const ends = srcset ? /[/?#,\s]/ : /[/?#]/;
  for (const p of parts.slice(index + 1)) {
    if (p.kind === "section") continue;
    if (p.kind === "value") return "composed";
    const stop = p.text.search(ends);
    const head = stop === -1 ? p.text : p.text.slice(0, stop);
    if (head.includes(":")) return "composed";
    if (stop !== -1) return "whole";
  }
  return "whole";
}
