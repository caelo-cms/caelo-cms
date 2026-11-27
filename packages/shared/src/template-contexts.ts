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
 * **The browser's reading decides.** The template is parsed by parse5, an
 * implementation of the HTML standard's tokenizer and tree construction
 * (foreign content and its integration points, the scripting flag on as in
 * a browser), as the content of a `<body>`. A parser that reads HTML
 * differently from a browser puts a value somewhere other than where the
 * browser puts it: htmlparser2 read `<script/>`, `<noscript>`, an SVG
 * `<title>`, `<!-->` and a double-escaped `</script>` differently, and each
 * difference ran a plugin's value as code (#1732 review).
 *
 * Worked out once per template text and kept for the most recent templates
 * ({@link CONTEXT_CACHE_SIZE}); a render with no plugin value never asks.
 * Two readings:
 *
 * - **Values.** Every section rendered once: section, comment and partial
 *   tags are left out, and each value tag becomes a marker of letters, so it
 *   reads where a value would (inside a name, a value or text). Where parse5
 *   puts a marker is where the browser puts the value; a marker it drops (an
 *   `<img>` inside `<select>`, a repeated attribute) refuses the value.
 * - **Sections.** Reading with every section rendered once holds for every
 *   render only when no section can change the HTML state around it:
 *   removing a block, or repeating it, must leave every other tag where it
 *   was. Every tag becomes a marker, and a section's open and close tag must
 *   stand at the same kind of boundary, where joining the text on either
 *   side reads as before:
 *   - both in element content of the same HTML or foreign (SVG, MathML)
 *     context, not in a comment and not in the text of `<script>`,
 *     `<style>`, `<title>`, `<textarea>`, `<noscript>` or another element
 *     whose content is text;
 *   - both in the value of the same attribute, and not at the start of an
 *     unquoted one (`title={{#a}}x{{/a}} class="…"` would lose its value and
 *     take the next attribute as it);
 *   - both between the attributes of the same tag, each right after
 *     whitespace or a closing quote (`<a {{#ext}}target="_blank"{{/ext}}>`);
 *     the open tag may also end the tag name (`<li{{#on}} class="on"{{/on}}>`)
 *     when what follows the close tag cannot continue that name.
 *
 *   A section anywhere else, a `{{! comment }}` where a section could not
 *   stand, a nested module's partial outside HTML element content, a
 *   delimiter change, and a value tag that is all an unquoted attribute
 *   value holds (it may render empty, and the next attribute becomes the
 *   value) refuse every plugin value after them, as
 *   `context-conditional-markup`.
 *
 * An attribute or element a value names is unknown until the render: its
 * attribute values are refused (`context-tag`), and when the element could
 * be one that changes how its content is read (`<{{tag}}>` could be
 * `script` or `svg`), so is every plugin value after it.
 */

import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as H, parseFragment } from "parse5";
import { htmlTokens } from "./html-tokens.js";
import { isLinkScheme, type PlaceholderContext } from "./lists/plugin-values.js";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type Attribute = Element["attrs"][number];

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

/** HTML elements whose content a browser reads as text (RCDATA, RAWTEXT with scripting on, PLAINTEXT). */
const TEXT_ONLY_ELEMENTS = new Set([
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

/** Elements that change how what follows them is read: an element a value names could be one. */
const READING_ELEMENTS = [...TEXT_ONLY_ELEMENTS, "script", "style", "svg", "math", "select"];

/** How many templates' contexts are kept: enough for every module a build renders over and over. */
export const CONTEXT_CACHE_SIZE = 512;

/** What a `{{…}}` tag is: a value, a section's open or close tag, a comment, a partial, a delimiter change. */
type TagKind = "value" | "open" | "close" | "comment" | "partial" | "delimiters";

/** One `{{…}}` / `{{{…}}}` tag of a template: `[start, end)` and its kind. */
interface MustacheSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: TagKind;
}

/** The contexts of one template, by the offset of a tag's `{{`. */
export interface PlaceholderContexts {
  readonly byStart: ReadonlyMap<number, PlaceholderContext>;
  /**
   * The nested modules (`{{>name}}` partials, `{{#name}}` module lists,
   * a list entry's `{{>field}}`) placed anywhere but plain HTML element
   * content: in an attribute, raw text, SVG or MathML, a `<select>`, or
   * after markup a section can change. A nested module's values are
   * checked against its own template read as a `<body>`'s content, which
   * only holds there; elsewhere every plugin value inside it is refused.
   */
  readonly nestedOutsideContent: ReadonlySet<string>;
  /**
   * The template ends in plain HTML element content, in every render: not
   * in raw text, SVG, MathML, a `<select>`, a comment or an unfinished tag,
   * and no section or value-named element could make it end elsewhere. A
   * module that does not changes how everything after it on the page reads
   * (see `page-reading.ts`).
   */
  readonly endsInContent: boolean;
  /**
   * #1748 — where each value tag sits for a CORE value, by the offset of
   * its `{{` (the inner one of a `{{{…}}}` too), checked by
   * `core-value-structure.ts`. The values reading's places (more than one
   * where parse5 copied a marker), kept also where a plugin's value is
   * refused because a section could change the reading: a core value is
   * refused only where it surely changes the structure around it. A tag
   * the reading lost (a marker parse5 dropped) has no entry.
   */
  readonly corePlaces: ReadonlyMap<number, readonly CorePlace[]>;
}

/**
 * #1748 — where a value tag sits, as the structure rule for a CORE value
 * reads it (`core-value-structure.ts`): what in the value would change the
 * markup around it depends only on this. `after` is the template's text
 * right after the tag ({@link CORE_AFTER} characters, another tag's
 * marker included), which can complete what the value starts: the `>` of
 * a `</textarea` or of a comment's `--`, the letter of a trailing `<`.
 */
export type CorePlace =
  /**
   * Element content. `open`: the start tags of the elements around the
   * value, outermost first (`<div><template>`), to read the value inside
   * them; null when they cannot be written back (inside `<head>`).
   * `plain`: no SVG, MathML or `<select>` around it.
   */
  | {
      readonly kind: "content";
      readonly open: string | null;
      readonly plain: boolean;
      readonly after: string;
    }
  /** The text of an HTML element only its end tag ends: `script`, `style`, `title`, `textarea`, … */
  | { readonly kind: "raw-text"; readonly element: string; readonly after: string }
  /** A comment's text; `atStart` right after its `<!--`. */
  | { readonly kind: "comment"; readonly atStart: boolean; readonly after: string }
  /** An attribute's value: its quote (null unquoted), and whether the value starts it. */
  | { readonly kind: "attribute"; readonly quote: '"' | "'" | null; readonly atStart: boolean }
  /** A tag's name (`inName`) or its attribute list (`<div {{attrs}}>`). */
  | { readonly kind: "tag"; readonly inName: boolean };

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
    const kind: TagKind =
      sigil === "#" || sigil === "^"
        ? "open"
        : sigil === "/"
          ? "close"
          : sigil === "!"
            ? "comment"
            : sigil === ">"
              ? "partial"
              : sigil === "="
                ? "delimiters"
                : "value";
    out.push({ start, end, kind });
    from = end;
  }
  return out;
}

const CONTENT: PlaceholderContext = { kind: "text", markup: true };
const PLAIN_TEXT: PlaceholderContext = { kind: "text", markup: false };
const refusal = (rule: string): PlaceholderContext => ({ kind: "refused", rule });

function computeContexts(html: string): PlaceholderContexts {
  const tags = mustacheSpans(html);
  const byStart = new Map<number, PlaceholderContext>();
  const markers = markerSet(html);
  if (tags.length === 0) {
    const text = `${html}${markers.mark(0)}`;
    const root = parseBody(text);
    return {
      byStart,
      nestedOutsideContent: new Set(),
      corePlaces: new Map(),
      // A browser keeps markup in a `<select>` that this reading drops.
      endsInContent:
        isPlainContent(placesOf(root, markers).get(0)) &&
        selectDivergence(root, text) === Number.POSITIVE_INFINITY,
    };
  }

  const values = readValues(html, tags, markers);
  const sections = sectionsUnsafeFrom(html, tags, markers);
  const unsafeFrom = Math.min(values.unsafeFrom, sections.from);
  const nestedOutsideContent = new Set(sections.outside);
  for (const [i, tag] of tags.entries()) {
    if ((tag.kind === "partial" || tag.kind === "open") && tag.start > unsafeFrom) {
      nestedOutsideContent.add(tagName(html, tags[i] as MustacheSpan));
    }
  }
  const conditional = refusal("context-conditional-markup");
  for (const [i, tag] of tags.entries()) {
    if (tag.kind !== "value") continue;
    const context =
      tag.start > unsafeFrom ? conditional : (values.contexts.get(i) ?? refusal("context-markup"));
    byStart.set(tag.start, context);
    // A triple-stache's inner `{{` is where the section pass sees the tag.
    if (html[tag.start + 2] === "{") byStart.set(tag.start + 1, context);
  }
  const corePlaces = new Map<number, readonly CorePlace[]>();
  for (const [i, places] of values.corePlaces) {
    const tag = tags[i] as MustacheSpan;
    corePlaces.set(tag.start, places);
    if (html[tag.start + 2] === "{") corePlaces.set(tag.start + 1, places);
  }
  return {
    byStart,
    nestedOutsideContent,
    corePlaces,
    // Where the reading of the end marker holds in every render (not where
    // the value rules stop trusting the reading: a value after an unquoted
    // `alt={{alt}}` is refused, but the module still ends where it ends).
    endsInContent: values.endsInContent && values.endHolds && sections.endHolds,
  };
}

/** The name a `{{#name}}` / `{{>name}}` tag names. */
function tagName(html: string, tag: MustacheSpan): string {
  return html
    .slice(tag.start + 2, tag.end - 2)
    .replace(/^\s*[#^/>!=&]?\s*/, "")
    .trim();
}

// ── Markers ────────────────────────────────────────────────────────────

/** Letters a marker's number is written in; the fence around it uses others. */
const DIGITS = "abcdefghijklmnop";

interface MarkerSet {
  /** The marker of tag `i`. */
  mark(i: number): string;
  /** The tag numbers of the markers in `text`, in order. */
  find(text: string): number[];
}

/**
 * Markers for `html`'s tags: a fence the template does not hold, around
 * the tag's number written in `a`–`p`. Letters only: parse5 lowercases
 * names, and a marker must read where a value would.
 *
 * The fence is `q` and then letters from `r`–`z`, so no concatenation of
 * template text and markers forms it by accident (its first letter occurs
 * nowhere else in it). Its length is the least for which there are more
 * fences than places a fence could start in the template (each `q`), so one
 * is free: a module of inline base64, which holds every short fence, gets a
 * longer one, and this never fails.
 */
function markerSet(html: string): MarkerSet {
  const lower = html.toLowerCase();
  const starts: number[] = [];
  for (let at = lower.indexOf("q"); at !== -1; at = lower.indexOf("q", at + 1)) starts.push(at);
  const TAIL = "rstuvwxyz";
  let length = 3;
  while (TAIL.length ** (length - 1) <= starts.length) length += 1;
  const taken = new Set(starts.map((at) => lower.slice(at, at + length)));
  let fence = "";
  for (let n = 0; ; n += 1) {
    let tail = "";
    for (let k = n, d = 0; d < length - 1; d += 1, k = Math.floor(k / TAIL.length)) {
      tail += TAIL[k % TAIL.length];
    }
    if (!taken.has(`q${tail}`)) {
      fence = `q${tail}`;
      break;
    }
  }
  const f = fence;
  const re = new RegExp(`${f}([${DIGITS}]+)${f}`, "g");
  return {
    mark: (i) =>
      f +
      i
        .toString(16)
        .split("")
        .map((d) => DIGITS[Number.parseInt(d, 16)])
        .join("") +
      f,
    find: (text) =>
      text.includes(f)
        ? [...text.matchAll(re)].map((m) =>
            Number.parseInt(
              [...(m[1] as string)].map((d) => DIGITS.indexOf(d).toString(16)).join(""),
              16,
            ),
          )
        : [],
  };
}

// ── Reading a marked template ──────────────────────────────────────────

/** Where parse5 put a marker. */
type Place =
  | {
      readonly at: "text";
      readonly parent: Element | null;
      /** The nearest SVG or MathML ancestor (the element itself included), or null. */
      readonly foreign: Element | null;
      /** The nearest `<select>` ancestor, or null (see {@link selectContent}). */
      readonly select: Element | null;
      /** The open elements around it, innermost first (#1748: a core value's check rebuilds them). */
      readonly chain: Ancestors | null;
    }
  | { readonly at: "comment"; readonly node: DefaultTreeAdapterTypes.CommentNode }
  | { readonly at: "doctype" }
  | { readonly at: "tag-name"; readonly element: Element }
  | {
      readonly at: "attr-name" | "attr-value";
      readonly element: Element;
      readonly attribute: Attribute;
    };

/** The elements open around a place, innermost first, as a linked list (no copy per level). */
interface Ancestors {
  readonly element: Element;
  readonly up: Ancestors | null;
}

/** Parse `text` as a `<body>`'s content, the way a browser with scripting on reads it. */
function parseBody(text: string): DefaultTreeAdapterTypes.DocumentFragment {
  const body = defaultTreeAdapter.createElement("body", H.NS.HTML, []);
  return parseFragment(body, text, { sourceCodeLocationInfo: true, scriptingEnabled: true });
}

/**
 * Every marker of `text`'s parse, by tag number (a marker parse5 copied, as
 * a cloned formatting element's attribute, more than once). Walked with a
 * stack of its own, never by recursion: a template nested thousands deep
 * is read, not a stack overflow.
 */
function placesOf(root: Node, markers: MarkerSet): Map<number, Place[]> {
  const out = new Map<number, Place[]>();
  const add = (s: string, place: Place) => {
    for (const i of markers.find(s)) {
      const list = out.get(i);
      if (list) list.push(place);
      else out.set(i, [place]);
    }
  };
  type Frame = {
    readonly node: Node;
    readonly parent: Element | null;
    readonly foreign: Element | null;
    readonly select: Element | null;
    readonly chain: Ancestors | null;
  };
  const stack: Frame[] = [{ node: root, parent: null, foreign: null, select: null, chain: null }];
  // Children are pushed in reverse, so they come off the stack in document order.
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { node, parent, foreign, select, chain } = frame;
    const children: readonly Node[] =
      "content" in node && node.content
        ? (node.content as DefaultTreeAdapterTypes.DocumentFragment).childNodes
        : "childNodes" in node
          ? node.childNodes
          : [];
    const next: Frame[] = [];
    for (const child of children) {
      if (child.nodeName === "#text") {
        add((child as DefaultTreeAdapterTypes.TextNode).value, {
          at: "text",
          parent,
          foreign,
          select,
          chain,
        });
      } else if (child.nodeName === "#comment") {
        const comment = child as DefaultTreeAdapterTypes.CommentNode;
        add(comment.data, { at: "comment", node: comment });
      } else if (child.nodeName === "#documentType") {
        const d = child as DefaultTreeAdapterTypes.DocumentType;
        add(`${d.name} ${d.publicId} ${d.systemId}`, { at: "doctype" });
      } else if ("tagName" in child) {
        const element = child as Element;
        add(element.tagName, { at: "tag-name", element });
        for (const attribute of element.attrs) {
          add(attributeName(attribute), { at: "attr-name", element, attribute });
          add(attribute.value, { at: "attr-value", element, attribute });
        }
        next.push({
          node: element,
          parent: element,
          foreign: element.namespaceURI !== H.NS.HTML ? element : foreign,
          select:
            element.namespaceURI === H.NS.HTML && element.tagName === "select" ? element : select,
          chain: { element, up: chain },
        });
      }
    }
    for (let k = next.length - 1; k >= 0; k -= 1) stack.push(next[k] as Frame);
  }
  return out;
}

/** An attribute's name as written (`xlink:href` for an adjusted foreign one), lowercased. */
function attributeName(a: Attribute): string {
  return (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase();
}

/** Where an attribute's source location is, by the name it was written with. */
function attributeLocation(element: Element, a: Attribute) {
  const attrs = element.sourceCodeLocation?.attrs;
  if (!attrs) return undefined;
  return attrs[attributeName(a)] ?? attrs[a.name] ?? attrs[a.name.toLowerCase()];
}

/**
 * The value part of an attribute written at `[start, end)` of `text`:
 * `[valueStart, valueEnd)` without the quotes, and whether it is quoted.
 */
function attributeValueSpan(
  text: string,
  start: number,
  end: number,
): {
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quoted: boolean;
  /** For a quoted value: whether its closing quote is there (`valueEnd` is then its offset). */
  readonly closed: boolean;
} | null {
  const eq = text.indexOf("=", start);
  if (eq === -1 || eq >= end) return null;
  let v = eq + 1;
  while (v < end && /[\t\n\f\r ]/.test(text[v] as string)) v += 1;
  const q = text[v];
  if (q === '"' || q === "'") {
    const closed = text[end - 1] === q && end - 1 > v;
    return { valueStart: v + 1, valueEnd: closed ? end - 1 : end, quoted: true, closed };
  }
  return { valueStart: v, valueEnd: end, quoted: false, closed: false };
}

// ── Values ─────────────────────────────────────────────────────────────

/** One literal run of the values reading: `len` characters at `a` there, `t` in the template. */
interface Segment {
  readonly a: number;
  readonly t: number;
  readonly len: number;
}

/**
 * The context of every value tag, read with every section rendered once,
 * and the offset from which an element a value names could change how the
 * rest is read (Infinity when none).
 */
function readValues(
  html: string,
  tags: readonly MustacheSpan[],
  markers: MarkerSet,
): {
  readonly contexts: Map<number, PlaceholderContext>;
  readonly unsafeFrom: number;
  /** The end marker reads as plain HTML content (see {@link isPlainContent}). */
  readonly endsInContent: boolean;
  /**
   * No render ends elsewhere than this reading: no markup in a `<select>`,
   * no value naming an element that could change the reading, and no
   * unquoted value that renders empty moves the end of its tag.
   */
  readonly endHolds: boolean;
  /** Per value tag (by index), its places for a core value. */
  readonly corePlaces: ReadonlyMap<number, readonly CorePlace[]>;
} {
  let text = "";
  const segments: Segment[] = [];
  const markerSpans: { readonly a: number; readonly end: number; readonly tag: number }[] = [];
  let at = 0;
  for (const [i, tag] of tags.entries()) {
    if (tag.start > at) {
      segments.push({ a: text.length, t: at, len: tag.start - at });
      text += html.slice(at, tag.start);
    }
    if (tag.kind === "value") {
      const m = markers.mark(i);
      markerSpans.push({ a: text.length, end: text.length + m.length, tag: i });
      text += m;
    }
    at = tag.end;
  }
  if (at < html.length) {
    segments.push({ a: text.length, t: at, len: html.length - at });
    text += html.slice(at);
  }
  // Where the template ends: a marker after it must be text in plain HTML
  // content, or what follows this module on the page reads otherwise.
  const end = tags.length;
  text += markers.mark(end);

  // The template offset of the character at `a` of the reading (a marker's: its tag's start).
  const toTemplate = (a: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid] as Segment;
      if (a < s.a) hi = mid - 1;
      else if (a >= s.a + s.len) lo = mid + 1;
      else return s.t + (a - s.a);
    }
    const m = markerAt(a);
    return m ? (tags[m.tag] as MustacheSpan).start : html.length;
  };
  // The marker holding the character at `a`, if one does.
  const markerAt = (a: number) => {
    let lo = 0;
    let hi = markerSpans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = markerSpans[mid] as (typeof markerSpans)[number];
      if (a < m.a) hi = mid - 1;
      else if (a >= m.end) lo = mid + 1;
      else return m;
    }
    return undefined;
  };
  // The template offset just after the character at `a - 1`.
  const endToTemplate = (a: number): number => {
    if (a <= 0) return 0;
    const m = markerAt(a - 1);
    return m ? (tags[m.tag] as MustacheSpan).end : toTemplate(a - 1) + 1;
  };

  const root = parseBody(text);
  const places = placesOf(root, markers);
  const contexts = new Map<number, PlaceholderContext>();
  let unsafeFrom = selectDivergence(root, text);
  if (unsafeFrom !== Number.POSITIVE_INFINITY) unsafeFrom = toTemplate(unsafeFrom);
  unsafeFrom = Math.min(unsafeFrom, endTagNameValues(html, tags));
  // Each of those can end a render elsewhere: a browser keeps markup in a
  // `<select>` that this reading drops, and an end tag a value names may
  // close raw text this reading keeps open.
  let endHolds = unsafeFrom === Number.POSITIVE_INFINITY;
  // Per start tag, the unquoted values that may render empty.
  const emptyable = new Map<Element, Map<number, number>>();
  const markerStart = new Map(markerSpans.map((m) => [m.tag, m.a]));
  const corePlaces = new Map<number, readonly CorePlace[]>();
  for (const [i, tag] of tags.entries()) {
    if (tag.kind !== "value") continue;
    const found = places.get(i) ?? [];
    const core = found
      .map((place) => corePlaceOf(place, markers.mark(i), markerStart.get(i) ?? -1, text))
      .filter((c): c is CorePlace => c !== null);
    if (core.length > 0) corePlaces.set(i, core);
    const read: PlaceholderContext[] = [];
    for (const place of found) {
      if (place.at === "tag-name" && couldChangeReading(place.element.tagName, markers)) {
        unsafeFrom = Math.min(unsafeFrom, tag.start);
        endHolds = false;
      }
      if (spellingMayEndText(place, i, { html, tags, toTemplate })) {
        // Empty, or spelled with `-`/`!`, it may end the raw text or the
        // comment it stands in (`<{{v}}/textarea>`, `<!--{{v}}->`).
        unsafeFrom = Math.min(unsafeFrom, tag.start);
        endHolds = false;
      }
      if (place.at === "attr-value" && valueIsOnlyTags(place.attribute, markers, text, place)) {
        // It may render empty: the browser then takes the next attribute as this value.
        unsafeFrom = Math.min(unsafeFrom, tag.start);
        const loc = attributeLocation(place.element, place.attribute);
        const span = loc ? attributeValueSpan(text, loc.startOffset, loc.endOffset) : null;
        if (span) {
          const ranges = emptyable.get(place.element) ?? new Map<number, number>();
          ranges.set(span.valueStart, span.valueEnd);
          emptyable.set(place.element, ranges);
        } else {
          endHolds = false;
        }
      }
      read.push(valueContext(place, tag, { html, tags, text, toTemplate, endToTemplate, markers }));
    }
    const first = read[0];
    contexts.set(
      i,
      first && read.every((c) => JSON.stringify(c) === JSON.stringify(first))
        ? first
        : refusal("context-markup"),
    );
  }
  for (const [element, ranges] of emptyable) {
    if (!tagEndHolds(text, element, ranges)) endHolds = false;
  }
  return {
    contexts,
    unsafeFrom,
    endsInContent: isPlainContent(places.get(end)),
    endHolds,
    corePlaces,
  };
}

/**
 * #1748 — a value tag's place as the core value rule reads it, or null
 * where no value can change the structure (a doctype).
 *
 * @param mark the tag's marker; `at` where it starts in `text`, the reading.
 */
function corePlaceOf(place: Place, mark: string, at: number, text: string): CorePlace | null {
  const after = at < 0 ? "" : text.slice(at + mark.length, at + mark.length + CORE_AFTER);
  switch (place.at) {
    case "text": {
      const parent = place.parent;
      const name = parent?.tagName.toLowerCase() ?? "";
      if (
        parent?.namespaceURI === H.NS.HTML &&
        (name === "script" || name === "style" || TEXT_ONLY_ELEMENTS.has(name))
      ) {
        return { kind: "raw-text", element: name, after };
      }
      return {
        kind: "content",
        open: openTagsOf(place.chain),
        plain: place.foreign === null && place.select === null,
        after,
      };
    }
    case "comment":
      return { kind: "comment", atStart: place.node.data.startsWith(mark), after };
    case "attr-value": {
      const loc = attributeLocation(place.element, place.attribute);
      const span = loc ? attributeValueSpan(text, loc.startOffset, loc.endOffset) : null;
      if (!span) return null;
      const q = text[span.valueStart - 1];
      return {
        kind: "attribute",
        quote: span.quoted && (q === '"' || q === "'") ? q : null,
        atStart: span.valueStart === at,
      };
    }
    case "tag-name":
      return { kind: "tag", inName: true };
    case "attr-name":
      return { kind: "tag", inName: false };
    case "doctype":
      return null;
  }
}

/** How much of the template after a value tag a {@link CorePlace} keeps: enough for an end tag's name. */
const CORE_AFTER = 16;

/**
 * The start tags of `chain`'s elements, outermost first, which put a value
 * read after them where the template puts it; null when they cannot (an
 * element of `<head>` or a frameset reads otherwise in a body). Attributes
 * are left out: none changes how the content is read, but the encoding
 * that makes a MathML `<annotation-xml>` hold HTML.
 */
function openTagsOf(chain: Ancestors | null): string | null {
  const tags: string[] = [];
  for (let c = chain; c !== null; c = c.up) {
    const e = c.element;
    const name = e.tagName;
    if (e.namespaceURI === H.NS.HTML) {
      if (name === "html" || name === "body") continue;
      if (name === "head" || name === "frameset" || name === "frame") return null;
    }
    const encoding =
      e.namespaceURI === H.NS.MATHML && name === "annotation-xml"
        ? e.attrs.find((a) => a.name === "encoding")
        : undefined;
    tags.push(
      encoding ? `<${name} encoding="${encoding.value.replaceAll('"', "&quot;")}">` : `<${name}>`,
    );
  }
  return tags.reverse().join("");
}

/**
 * Up to `n` characters of the template next to tag `i` (after it, or
 * before it), with every other tag left out: a tag may render nothing.
 * `offsets` are the characters' template offsets.
 */
function nearbyText(
  html: string,
  tags: readonly MustacheSpan[],
  i: number,
  direction: 1 | -1,
  n: number,
): { readonly text: string; readonly offsets: readonly number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  const self = tags[i] as MustacheSpan;
  let k = i + direction;
  let at = direction === 1 ? self.end : self.start - 1;
  while (chars.length < n && at >= 0 && at < html.length) {
    const t = tags[k];
    if (t !== undefined && (direction === 1 ? at === t.start : at === t.end - 1)) {
      at = direction === 1 ? t.end : t.start - 1;
      k += direction;
      continue;
    }
    chars.push(html[at] as string);
    offsets.push(at);
    at += direction;
  }
  if (direction === -1) {
    chars.reverse();
    offsets.reverse();
  }
  return { text: chars.join(""), offsets };
}

/**
 * Whether value tag `i`, where this reading puts it (as a marker: a
 * non-empty word), may end the text it stands in once it renders empty or
 * spelled with characters an escaped value can hold (`-`, `!`, `]`): an
 * end tag of raw text or RCDATA (`<{{v}}/textarea>`), a comment's end
 * (`<!--{{v}}->`, `-{{v}}->` before a later `-->`) or start (`<!{{v}}--`),
 * an end tag or comment where this reading has a start tag
 * (`<{{v}}/p>`, `<{{v}}!--`), or the end of CDATA in SVG or MathML. A
 * value can spell no `<` or `>`, so the template's own characters next to
 * it decide; real modules write none of this.
 */
function spellingMayEndText(
  place: Place,
  i: number,
  env: {
    readonly html: string;
    readonly tags: readonly MustacheSpan[];
    readonly toTemplate: (a: number) => number;
  },
): boolean {
  const before = nearbyText(env.html, env.tags, i, -1, 3).text;
  const after = nearbyText(env.html, env.tags, i, 1, 8);
  switch (place.at) {
    case "comment": {
      // `<!` and a word read as a bogus comment, ending at the first `>`;
      // empty, `<!{{v}}--` starts a real one.
      if (/<!-?$/.test(before)) return true;
      // Only `-` and `!` before a `>`: the value may complete `-->` or
      // `--!>` there (or `<!-->`), unless that `>` ends the comment anyway.
      const close = /^[-!]*>/.exec(after.text);
      if (close === null) return false;
      const gt = after.offsets[close[0].length - 1];
      const loc = place.node.sourceCodeLocation;
      return loc == null || env.toTemplate(loc.endOffset - 1) !== gt;
    }
    case "text": {
      if (place.foreign !== null && env.html.includes("<![CDATA[")) return true;
      const parent = place.parent;
      if (parent === null || parent.namespaceURI !== H.NS.HTML) return false;
      const name = parent.tagName.toLowerCase();
      if (name === "script") {
        // `</script`, `<!--` (the escaped states), `<script` inside them…
        if (/<!?-?$/.test(before)) return true;
        // …and `-->`, which leaves them.
        return env.html.includes("<!--") && /^[-!]*>/.test(after.text);
      }
      // An end tag `</name` needs the template's `<` right before the value.
      return (name === "style" || TEXT_ONLY_ELEMENTS.has(name)) && before.endsWith("<");
    }
    case "tag-name":
      // `<{{v}}/p>`, `<{{v}}!--`, `<{{v}}?`: empty, no start tag at all.
      return before.endsWith("<") && /^[!/?]/.test(after.text);
    default:
      return false;
  }
}

/** More unquoted values that may render empty in one start tag than this are not tried one by one. */
const MAX_EMPTYABLE_PER_TAG = 4;

/**
 * Whether `element`'s start tag ends where it does in this reading however
 * many of its unquoted values (`ranges`: value start to end in `text`)
 * render empty. An empty one makes the next attribute its value
 * (`alt= loading="lazy"`), which moves the end of the tag only when a `>`
 * or a quote in what follows then reads otherwise; everything after a tag
 * that ends in the same place reads the same. In SVG and MathML a tag's
 * closing `/` counts too: `r=/>` leaves `<foreignObject r={{v}}/>` open.
 */
function tagEndHolds(text: string, element: Element, ranges: ReadonlyMap<number, number>): boolean {
  const loc = element.sourceCodeLocation?.startTag;
  if (!loc || ranges.size > MAX_EMPTYABLE_PER_TAG) return false;
  const src = text.slice(loc.startOffset, loc.endOffset);
  const own = htmlTokens(src)[0];
  const selfClosing = own?.kind === "start" && own.selfClosing;
  const foreign = element.namespaceURI !== H.NS.HTML;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (let mask = 1; mask < 1 << sorted.length; mask += 1) {
    let variant = "";
    let at = 0;
    for (const [k, [from, to]] of sorted.entries()) {
      if ((mask & (1 << k)) === 0) continue;
      variant += src.slice(at, from - loc.startOffset);
      at = to - loc.startOffset;
    }
    variant += src.slice(at);
    // One start tag, ending where the source ends (an unfinished one is no token).
    const tokens = htmlTokens(variant);
    const token = tokens[0];
    if (tokens.length !== 1 || token?.kind !== "start") return false;
    if (foreign && token.selfClosing !== selfClosing) return false;
  }
  return true;
}

/**
 * Whether an end marker's places say the markup before it ends in plain
 * HTML element content: one text place, not in raw text, SVG, MathML or a
 * `<select>` (and not a comment, an attribute or an unfinished tag).
 */
function isPlainContent(found: readonly Place[] | undefined): boolean {
  if (found?.length !== 1) return false;
  const place = found[0] as Place;
  if (place.at !== "text" || place.foreign || place.select) return false;
  const name = place.parent?.tagName.toLowerCase() ?? "";
  if (name === "script" || name === "style") return false;
  return !(place.parent?.namespaceURI === H.NS.HTML && TEXT_ONLY_ELEMENTS.has(name));
}

/**
 * The offset of the first tag inside an end tag's name whose name could
 * close a reading element (`</{{end}}>`, `</{{e1}}{{e2}}>`, `</text{{a}}>`),
 * or Infinity. The tree shows raw text there; the render may close it.
 * Every tag in the name counts as any text, however many there are;
 * `</h{{n}}>` closes no element that changes how its content is read.
 */
function endTagNameValues(html: string, tags: readonly MustacheSpan[]): number {
  let first = Number.POSITIVE_INFINITY;
  for (let at = html.indexOf("</"); at !== -1; at = html.indexOf("</", at + 2)) {
    const pieces: string[] = [""];
    let tagStart = -1;
    let p = at + 2;
    for (;;) {
      if (html.startsWith("{{", p)) {
        const k = firstTagAfter(tags, p);
        const t = tags[k];
        if (t === undefined || t.start !== p) break;
        if (tagStart === -1) tagStart = t.start;
        pieces.push("");
        p = t.end;
      } else if (/[a-zA-Z0-9:_-]/.test(html[p] ?? "")) {
        pieces[pieces.length - 1] = `${pieces[pieces.length - 1] ?? ""}${html[p]}`;
        p += 1;
      } else break;
    }
    if (tagStart !== -1 && couldBeReadingElement(pieces)) first = Math.min(first, tagStart);
  }
  return first;
}

/** Whether an element whose name holds a value (`<{{tag}}>`, `<h{{n}}>`) could be one of {@link READING_ELEMENTS}. */
function couldChangeReading(tagName: string, markers: MarkerSet): boolean {
  const name = tagName.toLowerCase();
  const pieces: string[] = [];
  let at = 0;
  for (const i of markers.find(name)) {
    const m = markers.mark(i);
    const k = name.indexOf(m, at);
    pieces.push(name.slice(at, k));
    at = k + m.length;
  }
  pieces.push(name.slice(at));
  return couldBeReadingElement(pieces);
}

/** Whether a name of these literal pieces, with any text between them, could be one of {@link READING_ELEMENTS}. */
function couldBeReadingElement(pieces: readonly string[]): boolean {
  const pattern = new RegExp(
    `^${pieces.map((p) => p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return READING_ELEMENTS.some((e) => pattern.test(e));
}

/**
 * Where markup inside a `<select>` starts that browsers and parse5 read
 * differently (an offset of `text`), or Infinity. parse5 keeps only
 * `<option>`, `<optgroup>` and `<hr>` there and drops the rest; Chromium and
 * Firefox keep it, so a `<noscript>` inside a `<select>` is raw text to them
 * and not to the analysis. The selects are the tree's (a `<select>` in a
 * script's string or a `<textarea>` is text, and raw text before one hides
 * nothing), and each one's own source is read by its tokens, so a tag the
 * tree dropped counts. A `<select>` without its end tag diverges at once.
 */
function selectDivergence(root: Node, text: string): number {
  let first = Number.POSITIVE_INFINITY;
  const stack: Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const children: readonly Node[] =
      "content" in node && node.content
        ? (node.content as DefaultTreeAdapterTypes.DocumentFragment).childNodes
        : "childNodes" in node
          ? node.childNodes
          : [];
    for (const child of children) if ("tagName" in child) stack.push(child);
    if (!("tagName" in node)) continue;
    const element = node as Element;
    if (element.namespaceURI !== H.NS.HTML || element.tagName !== "select") continue;
    const loc = element.sourceCodeLocation;
    const from = loc?.startTag?.endOffset;
    const to = loc?.endTag?.startOffset;
    if (from === undefined || to === undefined) {
      first = Math.min(first, loc?.startOffset ?? 0);
      continue;
    }
    for (const t of htmlTokens(text.slice(from, to))) {
      if ((t.kind === "start" || t.kind === "end") && !SELECT_CONTENT.has(t.name)) {
        first = Math.min(first, from + t.start);
        break;
      }
    }
  }
  return first;
}

/** What a `<select>` holds that every parser reads alike. */
const SELECT_CONTENT = new Set(["option", "optgroup", "hr"]);

/** Whether an unquoted attribute value holds nothing but tags. */
function valueIsOnlyTags(
  attribute: Attribute,
  markers: MarkerSet,
  text: string,
  place: { readonly element: Element },
): boolean {
  const loc = attributeLocation(place.element, attribute);
  if (!loc) return false;
  const span = attributeValueSpan(text, loc.startOffset, loc.endOffset);
  if (!span || span.quoted) return false;
  let rest = attribute.value;
  for (const i of markers.find(rest)) rest = rest.replace(markers.mark(i), "");
  return rest === "";
}

interface ReadingEnv {
  readonly html: string;
  readonly tags: readonly MustacheSpan[];
  readonly text: string;
  readonly toTemplate: (a: number) => number;
  readonly endToTemplate: (a: number) => number;
  readonly markers: MarkerSet;
}

/** The context of a value tag at `place`. */
function valueContext(place: Place, tag: MustacheSpan, env: ReadingEnv): PlaceholderContext {
  switch (place.at) {
    case "comment":
      return PLAIN_TEXT;
    case "doctype":
      return refusal("context-markup");
    case "tag-name":
    case "attr-name":
      return refusal("context-tag");
    case "text": {
      const parent = place.parent;
      const name = parent?.tagName.toLowerCase() ?? "";
      if (name === "script") return refusal("context-script");
      if (name === "style") return refusal("context-style");
      if (parent?.namespaceURI === H.NS.HTML && TEXT_ONLY_ELEMENTS.has(name)) return PLAIN_TEXT;
      // Markup inside SVG or MathML leaves it (`<p>` breaks out), so a
      // richtext there is escaped like every other value; so it is inside a
      // `<select>`, whose content browsers and parse5 read differently.
      return place.foreign || place.select ? PLAIN_TEXT : CONTENT;
    }
    case "attr-value": {
      const element = place.element;
      const name = attributeName(place.attribute);
      if (env.markers.find(element.tagName).length > 0 || env.markers.find(name).length > 0) {
        return refusal("context-tag");
      }
      const loc = attributeLocation(element, place.attribute);
      const span = loc ? attributeValueSpan(env.text, loc.startOffset, loc.endOffset) : null;
      if (!loc || !span) return refusal("context-markup");
      return attributeContext(element, name, span.quoted, tag, {
        html: env.html,
        tags: env.tags,
        // After the opening quote, or the `=` (or space) before an unquoted value.
        start: env.toTemplate(span.valueStart - 1) + 1,
        end: span.closed ? env.toTemplate(span.valueEnd) : env.endToTemplate(span.valueEnd),
      });
    }
  }
}

/** The context of `tag` inside the value of attribute `n` of `element`. */
function attributeContext(
  element: Element,
  n: string,
  quoted: boolean,
  tag: MustacheSpan,
  value: {
    readonly html: string;
    readonly tags: readonly MustacheSpan[];
    readonly start: number;
    readonly end: number;
  },
): PlaceholderContext {
  const el = element.tagName.toLowerCase();
  const ns = element.namespaceURI;
  if (n.startsWith("on")) return refusal("context-event-handler");
  if (n === "style") return refusal("context-style-attribute");
  if (n === "srcdoc") return refusal("context-srcdoc");
  if (ns === H.NS.HTML && el === "meta") return refusal("context-meta");
  if (ns === H.NS.HTML && el === "base") return refusal("context-base");
  if (ns === H.NS.SVG && SVG_ANIMATION.has(el) && SVG_ANIMATION_ATTRIBUTES.has(n)) {
    return refusal("context-svg-animation");
  }
  const target = loadsOrSends(ns, el, n);
  if (target) return refusal(target);
  if (!URL_ATTRIBUTES.has(n)) return { kind: "attribute", quoted };
  const { position, afterSlash } = urlPosition(value.html, value.tags, n, value, tag);
  if (position === "template-scheme") return refusal("context-url-scheme");
  return { kind: "url", quoted, position, afterSlash };
}

/**
 * The rule for a URL attribute whose target the page runs as code or
 * hands a form to, or null: a plugin's value never becomes code, and a
 * link rule that admits any https address would load a script from it.
 */
function loadsOrSends(ns: string, el: string, n: string): string | null {
  if (n === "formaction" || (el === "form" && n === "action")) return "context-form-target";
  if (ns === H.NS.SVG)
    return el === "script" && (n === "href" || n === "xlink:href") ? "context-code-url" : null;
  if (ns !== H.NS.HTML) return null;
  const code =
    (el === "script" && n === "src") ||
    (el === "link" && (n === "href" || n === "imagesrcset")) ||
    ((el === "iframe" || el === "frame" || el === "embed" || el === "portal") && n === "src") ||
    (el === "object" && (n === "data" || n === "codebase" || n === "classid" || n === "archive")) ||
    (el === "applet" && (n === "code" || n === "codebase" || n === "archive")) ||
    (el === "html" && n === "manifest");
  return code ? "context-code-url" : null;
}

// ── Sections ───────────────────────────────────────────────────────────

/**
 * The offset from which the section structure can change the HTML state
 * around a tag (see the file note), or Infinity when it cannot.
 */
function sectionsUnsafeFrom(
  html: string,
  tags: readonly MustacheSpan[],
  markers: MarkerSet,
): {
  readonly from: number;
  readonly outside: readonly string[];
  /**
   * Every render ends where the values reading ends: each section keeps
   * what follows it, and every partial stands in plain content. A
   * `{{! }}` renders nothing, so it changes no render's end.
   */
  readonly endHolds: boolean;
} {
  const boundary = (k: TagKind) => k !== "value";
  if (!tags.some((t) => boundary(t.kind))) {
    return { from: Number.POSITIVE_INFINITY, outside: [], endHolds: true };
  }

  // First reading: which boundary markers end a name (`<li{{#a}}`, the
  // valueless `disabled{{/a}}`, an unquoted `x=1{{/a}}`).
  const first = markedTemplate(html, tags, markers, new Set());
  const firstPlaces = placesOf(parseBody(first.text), markers);
  const glued = new Set<number>();
  const tagNameEnd = new Set<number>();
  for (const [i, tag] of tags.entries()) {
    if (!boundary(tag.kind)) continue;
    const p = firstPlaces.get(i);
    const place = p?.length === 1 ? p[0] : undefined;
    const ends = place ? endsName(place, markers.mark(i)) : false;
    if (ends) glued.add(i);
    if (ends && place?.at === "tag-name") tagNameEnd.add(i);
  }
  // Second reading: a marker that ended a tag name stands apart, so the
  // element is the one a render has (`<script{{#a}} x{{/a}}>` is a script
  // either way). An attribute's name or value does not change how what
  // follows is read.
  const second = tagNameEnd.size > 0 ? markedTemplate(html, tags, markers, tagNameEnd) : first;
  const places = tagNameEnd.size > 0 ? placesOf(parseBody(second.text), markers) : firstPlaces;

  const ids = new Map<Element, number>();
  const id = (e: Element) => {
    let n = ids.get(e);
    if (n === undefined) {
      n = ids.size;
      ids.set(e, n);
    }
    return n;
  };
  const cdata = html.includes("<![CDATA[");
  const key = (i: number): Boundary | null => {
    const found = places.get(i);
    if (found?.length !== 1) return null;
    const place = found[0] as Place;
    const at = second.at[i] as number;
    switch (place.at) {
      case "text": {
        const parent = place.parent;
        const name = parent?.tagName.toLowerCase() ?? "";
        if (name === "script" || name === "style") return null;
        if (parent?.namespaceURI === H.NS.HTML && TEXT_ONLY_ELEMENTS.has(name)) return null;
        // In foreign content a CDATA section is text too; a block could end it.
        if (place.foreign && cdata) return null;
        // A block that opens or closes a `<select>` changes how what follows is read.
        const where = `${place.foreign ? id(place.foreign) : "html"}:${place.select ? id(place.select) : "-"}`;
        return { key: `text:${where}`, glued: false };
      }
      case "attr-value": {
        const loc = attributeLocation(place.element, place.attribute);
        const span = loc ? attributeValueSpan(second.text, loc.startOffset, loc.endOffset) : null;
        if (!span || (!span.quoted && span.valueStart === at)) return null;
        return {
          key: `value:${id(place.element)}:${attributeName(place.attribute)}`,
          glued: false,
        };
      }
      case "attr-name": {
        const loc = attributeLocation(place.element, place.attribute);
        // It starts a name (after whitespace or a closing quote), or ends
        // one that has no value (`disabled{{/a}}`).
        if (loc?.startOffset !== at && !glued.has(i)) return null;
        return { key: `tag:${id(place.element)}`, glued: glued.has(i) };
      }
      default:
        return null;
    }
  };

  let from = Number.POSITIVE_INFINITY;
  let endHolds = true;
  // Where a nested module renders: a partial's place, a section's (a module list).
  const outside: string[] = [];
  const nestedAt = (tag: MustacheSpan, k: Boundary | null) => {
    if (k?.key !== "text:html:-") outside.push(tagName(html, tag));
  };
  const open: { readonly tag: MustacheSpan; readonly key: Boundary | null }[] = [];
  for (const [i, tag] of tags.entries()) {
    switch (tag.kind) {
      case "value":
        break;
      case "open": {
        const k = key(i);
        nestedAt(tag, k);
        open.push({ tag, key: k });
        break;
      }
      case "close": {
        const o = open.pop();
        if (o === undefined) return { from: 0, outside, endHolds: false };
        if (!sectionKeeps(html, o.key, key(i), o.tag, tag)) {
          from = Math.min(from, o.tag.start);
          endHolds = false;
        }
        break;
      }
      case "comment": {
        // A comment is a section with no block.
        const k = key(i);
        if (!sectionKeeps(html, k, k, tag, tag)) from = Math.min(from, tag.start);
        break;
      }
      case "partial": {
        const k = key(i);
        nestedAt(tag, k);
        if (k?.key !== "text:html:-") {
          // Its module's markup may end the raw text or the value it stands in.
          from = Math.min(from, tag.start);
          endHolds = false;
        }
        break;
      }
      case "delimiters":
        from = Math.min(from, tag.start);
        endHolds = false;
        break;
    }
  }
  for (const o of open) {
    from = Math.min(from, o.tag.start);
    endHolds = false;
  }
  return { from, outside, endHolds };
}

/**
 * `html` with every tag as its marker, a space before those in `apart`;
 * `at[i]` is where tag `i`'s marker starts.
 */
function markedTemplate(
  html: string,
  tags: readonly MustacheSpan[],
  markers: MarkerSet,
  apart: ReadonlySet<number>,
): { readonly text: string; readonly at: number[] } {
  let text = "";
  const at: number[] = [];
  let from = 0;
  for (const [i, tag] of tags.entries()) {
    text += html.slice(from, tag.start);
    if (apart.has(i)) text += " ";
    at[i] = text.length;
    text += markers.mark(i);
    from = tag.end;
  }
  return { text: text + html.slice(from), at };
}

/**
 * A boundary a section tag stands at: `key` names it (a matching tag must
 * share it), `glued` when the tag ends a name, so a name character after
 * the block would continue that name.
 */
interface Boundary {
  readonly key: string;
  readonly glued: boolean;
}

/**
 * Whether a boundary marker at `place` (first reading) ends a tag name or
 * a valueless attribute name, written right after its last character.
 */
function endsName(place: Place, mark: string): boolean {
  const name =
    place.at === "tag-name"
      ? place.element.tagName.toLowerCase()
      : place.at === "attr-name" && place.attribute.value === ""
        ? attributeName(place.attribute)
        : "";
  return name.length > mark.length && name.endsWith(mark);
}

/** What ends a name or an unquoted value: whitespace, `/` or `>`. */
const ENDS_NAME = /[\t\n\f\r />]/;

/**
 * Whether a section from boundary `open` (the open tag `from`) to `close`
 * (the close tag `to`) leaves the HTML around it as it is: both at the same
 * boundary, and no name continued across the block. A comment is a section
 * with no block (`from` is `to`).
 */
function sectionKeeps(
  html: string,
  open: Boundary | null,
  close: Boundary | null,
  from: MustacheSpan,
  to: MustacheSpan,
): boolean {
  if (open === null || close === null || open.key !== close.key) return false;
  // Inside one attribute value a block only adds characters to that value.
  if (!open.key.startsWith("tag:")) return true;
  // Without the block, what follows the close tag joins the name the open tag ended.
  if (open.glued && !ENDS_NAME.test(html[to.end] ?? "")) return false;
  // Repeated, the block's start joins the name its end ends.
  if (
    close.glued &&
    from !== to &&
    from.end !== to.start &&
    !ENDS_NAME.test(html[from.end] ?? "")
  ) {
    return false;
  }
  return true;
}

// ── URL attributes ─────────────────────────────────────────────────────

/**
 * A part of an attribute value: literal text (as written, at its section
 * depth), a value tag, or a section tag (`#`/`^` open one, `/` closes it),
 * which carries no value. Comments and partials carry none either.
 */
type Part =
  | { readonly kind: "text"; readonly text: string; readonly conditional: boolean }
  | { readonly kind: "value"; readonly start: number; readonly conditional: boolean }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

/** What `tag`'s place in its URL attribute is ({@link urlPosition}). */
type UrlPosition = "whole" | "path" | "composed" | "template-scheme";

/** The index of the first tag ending after `offset` (tags are in order and do not overlap). */
function firstTagAfter(tags: readonly MustacheSpan[], offset: number): number {
  let lo = 0;
  let hi = tags.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((tags[mid] as MustacheSpan).end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where `tag` sits in its URL attribute's value `[value.start, value.end)`,
 * judged on the template's text as written, with only text outside sections
 * taken as always there (a section may render nothing). A `&` in that text
 * before the scheme part ends could start a character reference the
 * browser completes with the value or with text a section adds
 * (`{{x}}&#58;…`, `jav&#{{x}};…`), so it makes the URL composed: no
 * analysis of pieces can say what such a reference decodes to. (A plugin's
 * own `&` reaches a URL as `&amp;`, see `contextualPluginValue`, so the
 * value starts none.)
 *
 * - `path`: unconditional template text before it ends the scheme part
 *   (`/de/{{slug}}`, `mailto:{{x}}`); the value can only be a path, query
 *   or fragment. `afterSlash` when that text ends in `/`: a value starting
 *   with `/` would make `//host`;
 * - `template-scheme`: that text names a scheme that is no link scheme
 *   (`javascript:{{x}}`): the value would be code;
 * - `composed`: the scheme could be made of the value and other parts:
 *   text or a value before it without such an end, a `:`, a `&` or another
 *   value after it before one, a `&` before the end, or a section around
 *   it (a list section repeats it, and its entries could spell a scheme
 *   together);
 * - `whole`: the value decides the URL's scheme.
 *
 * A `srcset` holds one URL per comma; a `&` anywhere before the value in
 * its candidate could be a comma (`&#44;`) and makes it composed.
 */
function urlPosition(
  html: string,
  tags: readonly MustacheSpan[],
  name: string,
  value: { readonly start: number; readonly end: number },
  tag: MustacheSpan,
): { readonly position: UrlPosition; readonly afterSlash: boolean } {
  const parts: Part[] = [];
  let depth = 0;
  let at = value.start;
  const text = (from: number, to: number) => {
    if (to > from) parts.push({ kind: "text", text: html.slice(from, to), conditional: depth > 0 });
  };
  for (let k = firstTagAfter(tags, value.start); k < tags.length; k += 1) {
    const t = tags[k] as MustacheSpan;
    if (t.start >= value.end) break;
    text(at, t.start);
    if (t.kind === "value") parts.push({ kind: "value", start: t.start, conditional: depth > 0 });
    else if (t.kind === "close") {
      parts.push({ kind: "close" });
      depth = Math.max(0, depth - 1);
    } else if (t.kind === "open") {
      parts.push({ kind: "open" });
      depth += 1;
    }
    at = t.end;
  }
  text(at, value.end);
  const composed = { position: "composed", afterSlash: false } as const;
  const srcset = name === "srcset" || name === "imagesrcset";
  const index = parts.findIndex((p) => p.kind === "value" && p.start === tag.start);
  const self = parts[index];
  if (self === undefined || (self.kind === "value" && self.conditional)) return composed;

  // Before the value: from the last unconditional comma of a srcset on.
  let from = 0;
  if (srcset) {
    for (let k = index - 1; k >= 0; k -= 1) {
      const p = parts[k] as Part;
      if (p.kind === "text" && p.text.includes(",")) {
        if (p.conditional) return composed;
        from = k;
        break;
      }
    }
  }
  let prefix = "";
  // The same without the text sections add: what a render without them has.
  let always = "";
  for (const [k, p] of parts.slice(from, index).entries()) {
    if (p.kind === "value") return composed;
    // A section tag renders only its own block, whose text counts below.
    if (p.kind !== "text") continue;
    const t = srcset && k === 0 ? p.text.slice(p.text.lastIndexOf(",") + 1) : p.text;
    if (p.conditional && !/[:/?#]/.test(prefix)) {
      if (t.trim() !== "") return composed;
      continue;
    }
    prefix += t;
    if (!p.conditional) always += t;
  }
  const end = prefix.search(/[:/?#]/);
  if (prefix.slice(0, srcset || end === -1 ? prefix.length : end).includes("&")) return composed;
  if (end !== -1) {
    // With or without a section's text, the value may follow a `/`.
    const afterSlash = /[/\\]$/.test(prefix) || /[/\\]$/.test(always);
    if (prefix[end] !== ":") return { position: "path", afterSlash };
    const scheme = prefix
      .slice(0, end)
      .replace(/[\t\n\r]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser strips them.
      .replace(/^[\u0000- ]+/, "");
    return isLinkScheme(scheme)
      ? { position: "path", afterSlash }
      : { position: "template-scheme", afterSlash: false };
  }
  if (prefix.trim() !== "") return composed;

  // After the value: up to the first unconditional end of the scheme part.
  const ends = srcset ? /[/?#,\s]/ : /[/?#]/;
  for (const p of parts.slice(index + 1)) {
    if (p.kind === "open" || p.kind === "close") continue;
    if (p.kind === "value") return composed;
    const stop = p.conditional ? -1 : p.text.search(ends);
    const head = stop === -1 ? p.text : p.text.slice(0, stop);
    if (/[:&]/.test(head)) return composed;
    if (stop !== -1) return { position: "whole", afterSlash: false };
  }
  return { position: "whole", afterSlash: false };
}
