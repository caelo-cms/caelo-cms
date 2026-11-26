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
 *
 * The analysis reads the template with every section rendered once. That
 * holds for every render only when no section can change the HTML state
 * around it: removing a section's block, or repeating it, must leave every
 * other tag where it was. So each section's open and close tag must stand
 * at the same kind of boundary, where joining the text on either side
 * tokenizes as before:
 *
 * - both in element content (not a comment, not `<script>`, `<style>`,
 *   `<title>`, `<textarea>` or another element whose content is text);
 * - both in the value of the same attribute, and not at the start of an
 *   unquoted one (`title={{#a}}x{{/a}} class="…"` would lose its value
 *   and take the next attribute as it);
 * - both between the attributes of the same tag, each right after
 *   whitespace or a closing quote (`<a {{#ext}}target="_blank"{{/ext}}>`);
 *   the open tag may also end the tag name (`<li{{#on}} class="on"{{/on}}>`)
 *   when what follows the close tag cannot continue that name.
 *
 * A section anywhere else (`{{#f}}<!--{{/f}}`, `<{{#f}}x{{/f}}script>`, a
 * name it splits) refuses every plugin value from its open tag on, as
 * `context-conditional-markup`; so does a nested module's partial outside
 * element content. An attribute or element whose name holds a value tag is
 * unknown until the render, so its values are refused too.
 */

import { QuoteType, Tokenizer } from "htmlparser2";
import { isLinkScheme, type PlaceholderContext } from "./lists/plugin-values.js";

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

/**
 * One `{{…}}` tag: `[start, end)`; `section` for a section tag (`#`, `^`
 * open one, `/` closes it), which carries no value; `partial` for `{{>…}}`,
 * a nested module's markup.
 */
interface MustacheSpan {
  readonly start: number;
  readonly end: number;
  readonly section: "open" | "close" | null;
  readonly partial: boolean;
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
    out.push({
      start,
      end,
      section: sigil === "#" || sigil === "^" ? "open" : sigil === "/" ? "close" : null,
      partial: sigil === ">",
    });
    from = end;
  }
  return out;
}

/**
 * A span of the masked template and what a tag inside it is. `kind` and
 * `owner` (the offset of the `<` of the tag it belongs to) tell what
 * boundary a section tag inside it stands at.
 */
interface Region {
  readonly start: number;
  readonly end: number;
  readonly kind:
    | "text"
    | "special"
    | "comment"
    | "tag-name"
    | "tag"
    | "attr-name"
    | "attr-value"
    | "markup";
  readonly owner: number;
  /** For an attribute value: whether it is quoted. */
  readonly quoted?: boolean;
  readonly context: (tag: MustacheSpan) => PlaceholderContext;
}

/** Elements whose content htmlparser2 and a browser read as text, never as markup. */
const TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

function refused(rule: string): () => PlaceholderContext {
  const context: PlaceholderContext = { kind: "refused", rule };
  return () => context;
}

/** Element content: a plugin's richtext stays markup there. */
const CONTENT: PlaceholderContext = { kind: "text", markup: true };
/** A comment or a text-only element: everything is escaped text. */
const PLAIN_TEXT: PlaceholderContext = { kind: "text", markup: false };

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
  let elementNamed = false;
  let maskedElement = "";
  let tagStart = -1;
  let special: string | null = null;
  let attr: { name: string; named: boolean; start: number; end: number } | null = null;
  const name = (s: number, e: number) => masked.slice(s, e).toLowerCase();
  // A name as it renders: section tags add nothing to it; a value tag makes it unknown.
  const realName = (s: number, e: number): { name: string; named: boolean } => {
    let out = "";
    let at = s;
    let named = true;
    for (const t of tags) {
      if (t.end <= s || t.start >= e) continue;
      out += html.slice(at, Math.max(at, t.start));
      if (t.section === null) named = false;
      at = Math.min(e, t.end);
    }
    out += html.slice(at, e);
    return { name: out.toLowerCase(), named };
  };
  const region = (
    start: number,
    end: number,
    kind: Region["kind"],
    context: Region["context"],
    owner = -1,
    quoted?: boolean,
  ) =>
    regions.push({ start, end, kind, owner, context, ...(quoted === undefined ? {} : { quoted }) });
  const tokenizer = new Tokenizer(
    { decodeEntities: false },
    {
      onopentagname(s, e) {
        tagStart = s - 1;
        maskedElement = name(s, e);
        const n = realName(s, e);
        element = n.name;
        elementNamed = n.named;
        region(s, e, "tag-name", refused("context-tag"), tagStart);
      },
      onopentagend() {
        // htmlparser2 decides on the name it read: the masked one.
        special = TEXT_ELEMENTS.has(maskedElement) ? maskedElement : null;
      },
      onselfclosingtag() {
        special = null;
      },
      onclosetag(s, e) {
        special = null;
        region(s, e, "tag", refused("context-tag"), s - 2);
      },
      onattribname(s, e) {
        const n = realName(s, e);
        attr = { name: n.name, named: n.named, start: -1, end: -1 };
        region(s, e, "attr-name", refused("context-tag"), tagStart);
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
        const known = elementNamed && a.named;
        region(
          a.start,
          a.end,
          "attr-value",
          known
            ? (tag) => attributeContext(html, tags, owner, a, quoted, tag)
            : refused("context-tag"),
          tagStart,
          quoted,
        );
      },
      ontext(s, e) {
        const kind = special;
        if (kind === "script" || kind === "style")
          region(s, e, "special", refused(`context-${kind}`));
        else if (kind === null) region(s, e, "text", () => CONTENT);
        else region(s, e, "special", () => PLAIN_TEXT);
      },
      ontextentity() {},
      oncomment(s, e) {
        region(s, e, "comment", () => PLAIN_TEXT);
      },
      oncdata(s, e) {
        region(s, e, "markup", refused("context-markup"));
      },
      ondeclaration(s, e) {
        region(s, e, "markup", refused("context-markup"));
      },
      onprocessinginstruction(s, e) {
        region(s, e, "markup", refused("context-markup"));
      },
      onend() {},
    },
  );
  tokenizer.write(masked);
  tokenizer.end();

  regions.sort((a, b) => a.start - b.start);
  let r = 0;
  const regionOf = (tag: MustacheSpan): Region | null => {
    while (r < regions.length && (regions[r] as Region).end <= tag.start) r += 1;
    const found = regions[r];
    return found && found.start <= tag.start && tag.start < found.end ? found : null;
  };
  const regionByTag = new Map<MustacheSpan, Region | null>();
  for (const tag of tags) regionByTag.set(tag, regionOf(tag));

  const unsafeFrom = conditionalMarkupFrom(html, tags, regionByTag);
  const conditional: PlaceholderContext = { kind: "refused", rule: "context-conditional-markup" };
  for (const tag of tags) {
    if (tag.section !== null) continue;
    const found = regionByTag.get(tag) ?? null;
    const context =
      tag.start > unsafeFrom
        ? conditional
        : found
          ? found.context(tag)
          : ({ kind: "refused", rule: "context-markup" } as const);
    byStart.set(tag.start, context);
    // A triple-stache's inner `{{` is where the section pass sees the tag.
    if (html[tag.start + 2] === "{") byStart.set(tag.start + 1, context);
  }
  return { byStart };
}

/**
 * The boundary a section tag (or a partial) stands at, as a key that a
 * matching close tag must share, or null where it is no safe boundary
 * (see the file note).
 */
function boundaryKey(tag: MustacheSpan, region: Region | null): string | null {
  if (region === null) return null;
  switch (region.kind) {
    case "text":
      return "text";
    case "attr-value":
      return region.quoted === false && region.start === tag.start ? null : `value:${region.start}`;
    case "attr-name":
      // Only where it starts a name: right after whitespace or a closing quote.
      return region.start === tag.start ? `tag:${region.owner}` : null;
    case "tag-name":
      return region.end === tag.end ? `name-end:${region.owner}` : null;
    default:
      return null;
  }
}

/** What may follow a section that opened at the end of a tag name: no name character. */
const ENDS_TAG_NAME = /[\t\n\f\r />]/;

/** Whether a section from a boundary `open` to `close` (at `tag`) leaves the HTML around it as it is. */
function sectionKeeps(
  html: string,
  open: string | null,
  close: string | null,
  tag: MustacheSpan,
): boolean {
  if (open === null || close === null) return false;
  if (!open.startsWith("name-end:")) return open === close;
  // Without the block, what follows the close tag joins the tag name.
  return (
    close === `tag:${open.slice("name-end:".length)}` && ENDS_TAG_NAME.test(html[tag.end] ?? "")
  );
}

/**
 * The offset from which the section structure can change the HTML state
 * around a tag (a section whose open and close tag stand at different or
 * unsafe boundaries, an unbalanced section, a partial outside element
 * content), or Infinity when it cannot.
 */
function conditionalMarkupFrom(
  html: string,
  tags: readonly MustacheSpan[],
  regionByTag: ReadonlyMap<MustacheSpan, Region | null>,
): number {
  let from = Number.POSITIVE_INFINITY;
  const open: { readonly tag: MustacheSpan; readonly key: string | null }[] = [];
  for (const tag of tags) {
    const key = boundaryKey(tag, regionByTag.get(tag) ?? null);
    if (tag.partial) {
      if (key !== "text") from = Math.min(from, tag.start);
    } else if (tag.section === "open") {
      open.push({ tag, key });
    } else if (tag.section === "close") {
      const o = open.pop();
      if (o === undefined) return 0;
      if (!sectionKeeps(html, o.key, key, tag)) from = Math.min(from, o.tag.start);
    }
  }
  for (const o of open) from = Math.min(from, o.tag.start);
  return from;
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
  const position = urlPosition(html, tags, attr, tag);
  if (position === "template-scheme") return { kind: "refused", rule: "context-url-scheme" };
  return { kind: "url", quoted, position };
}

/**
 * A part of an attribute value: literal text (as a browser reads it, at
 * its section depth), a value tag, or a section tag (`#`/`^` open one,
 * `/` closes it), which carries no value.
 */
type Part =
  | { readonly kind: "text"; readonly text: string; readonly conditional: boolean }
  | { readonly kind: "value"; readonly start: number; readonly conditional: boolean }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

/** What `tag`'s place in its URL attribute is ({@link urlPosition}). */
type UrlPosition = "whole" | "path" | "composed" | "template-scheme";

/**
 * Where `tag` sits in its URL attribute's value, judged on the template's
 * text as written, with only text outside sections taken as always there
 * (a section may render nothing). A `&` in that text before the scheme
 * part ends could start a character reference the browser completes with
 * the value or with text a section adds (`{{x}}&#58;…`, `jav&#{{x}};…`),
 * so it makes the URL composed: no analysis of pieces can say what such a
 * reference decodes to. (A plugin's own `&` reaches a URL as `&amp;`, see
 * `contextualPluginValue`, so the value starts none.)
 *
 * - `path`: unconditional template text before it ends the scheme part
 *   (`/de/{{slug}}`, `mailto:{{x}}`); the value can only be a path, query
 *   or fragment;
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
  attr: { readonly name: string; readonly start: number; readonly end: number },
  tag: MustacheSpan,
): UrlPosition {
  const parts: Part[] = [];
  let depth = 0;
  let at = attr.start;
  const text = (from: number, to: number) => {
    if (to > from) {
      parts.push({
        kind: "text",
        text: html.slice(from, to),
        conditional: depth > 0,
      });
    }
  };
  for (const t of tags) {
    if (t.end <= attr.start || t.start >= attr.end) continue;
    text(at, t.start);
    if (!t.section) parts.push({ kind: "value", start: t.start, conditional: depth > 0 });
    else {
      const sigil = html.slice(t.start + 2, t.end).trimStart()[0];
      if (sigil === "/") {
        parts.push({ kind: "close" });
        depth = Math.max(0, depth - 1);
      } else {
        parts.push({ kind: "open" });
        depth += 1;
      }
    }
    at = t.end;
  }
  text(at, attr.end);
  const srcset = attr.name === "srcset" || attr.name === "imagesrcset";
  const index = parts.findIndex((p) => p.kind === "value" && p.start === tag.start);
  const self = parts[index];
  if (self?.kind === "value" && self.conditional) return "composed";

  // Before the value: from the last unconditional comma of a srcset on.
  let from = 0;
  if (srcset) {
    for (let k = index - 1; k >= 0; k -= 1) {
      const p = parts[k] as Part;
      if (p.kind === "text" && p.text.includes(",")) {
        if (p.conditional) return "composed";
        from = k;
        break;
      }
    }
  }
  let prefix = "";
  for (const [k, p] of parts.slice(from, index).entries()) {
    if (p.kind === "value") return "composed";
    // A section tag renders only its own block, whose text counts below.
    if (p.kind !== "text") continue;
    const t = srcset && k === 0 ? p.text.slice(p.text.lastIndexOf(",") + 1) : p.text;
    if (p.conditional && !/[:/?#]/.test(prefix)) {
      if (t.trim() !== "") return "composed";
      continue;
    }
    prefix += t;
  }
  const end = prefix.search(/[:/?#]/);
  if (prefix.slice(0, srcset || end === -1 ? prefix.length : end).includes("&")) return "composed";
  if (end !== -1) {
    if (prefix[end] !== ":") return "path";
    const scheme = prefix
      .slice(0, end)
      .replace(/[\t\n\r]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser strips them.
      .replace(/^[\u0000-\u0020]+/, "");
    return isLinkScheme(scheme) ? "path" : "template-scheme";
  }
  if (prefix.trim() !== "") return "composed";

  // After the value: up to the first unconditional end of the scheme part.
  const ends = srcset ? /[/?#,\s]/ : /[/?#]/;
  for (const p of parts.slice(index + 1)) {
    if (p.kind === "open" || p.kind === "close") continue;
    if (p.kind === "value") return "composed";
    const stop = p.conditional ? -1 : p.text.search(ends);
    const head = stop === -1 ? p.text : p.text.slice(0, stop);
    if (/[:&]/.test(head)) return "composed";
    if (stop !== -1) return "whole";
  }
  return "whole";
}
