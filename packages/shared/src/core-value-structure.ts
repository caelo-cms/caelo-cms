// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — a core value must not change the markup around its placeholder.
 *
 * Module HTML substitutes core values raw (CMS_REQUIREMENTS §3.1,
 * `template-engine.ts`): stored text holds entities and inline markup on
 * purpose, so escaping it would double-escape existing content. What a
 * value may not do is change the document's structure OUTSIDE itself where
 * the module places it. A site text `Die Datei sollte direkt mit <?xml
 * beginnen.` inside a `<template>` started a bogus comment that swallowed the
 * rest of the template, its `</template>` and the page footer, and nothing
 * said so (#1748).
 *
 * The rule, by where the placeholder sits (`template-contexts.ts` reads
 * that, `CorePlace`, from the same parse #1729 reads plugin values with):
 *
 * - **Element content.** The value may hold its own balanced markup and
 *   entities. It may not start a comment, a processing instruction, a
 *   bogus comment, CDATA or a doctype (`<!--`, `<?`, `<!`, `</` before a
 *   non-letter), close an element it did not open (`</div>`), leave one
 *   open (`<b>`), or open one that closes the element it is placed in (a
 *   `<p>` inside the module's `<p>`). Read by the HTML standard's tokenizer
 *   (`htmlTokens`) and tree builder (parse5) inside the elements the module
 *   puts around it, never by a regex: a `<` that starts no tag (`a < b`,
 *   `5<6`) is text, as the browser reads it.
 * - **Raw text and RCDATA** (`<script>`, `<style>`, `<title>`,
 *   `<textarea>`, …): no end tag of that element (`</script`), and in a
 *   script no `<!--`, which puts the tokenizer in the states where the
 *   module's own `</script>` may not end it.
 * - **A comment:** no `-->` or `--!>`; right after `<!--`, no `>` or `->`.
 * - **A quoted attribute value:** not that quote. **Unquoted:** no
 *   whitespace or `>`, and no quote at its start.
 * - **A tag's name or attribute list:** nothing that ends the tag.
 *
 * A literal `<` the editor meant as text is written `&lt;` (a `"` in an
 * attribute `&quot;`). Refusing never cleans (CLAUDE.md §2, no fallbacks):
 * a write that would store such a value is refused with the spelling and
 * the fix, and a value already stored renders as it always did, recorded as
 * the render failure {@link VALUE_BREAKS_MARKUP}, which a Stage reports and
 * Publish live refuses (#1604).
 *
 * Plugin values keep their own stricter rules (`lists/plugin-values.ts`).
 * The marker and its texts: `core-value-messages.ts`; the walks a write
 * runs: `core-value-writes.ts`.
 */

import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as H, parseFragment } from "parse5";
import { type HtmlToken, htmlTokens } from "./html-tokens.js";
import { type CorePlace, placeholderContexts } from "./template-contexts.js";

export type { CorePlace } from "./template-contexts.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** Marker kind of a core value that changes the markup around its placeholder. */
export const VALUE_BREAKS_MARKUP = "value-breaks-markup";

/** What in a value breaks the markup around it. */
export interface CoreValueProblem {
  /** Marker-safe (`[a-z0-9-]`): `processing-instruction`, `end-tag-div`, `unclosed-b`, … */
  readonly rule: string;
  /** The spelling in the value that does it, as written (at most {@link SPELLING_MAX} characters). */
  readonly spelling: string;
  /** Where the module places the value, in words (`element content inside <template>`). */
  readonly place: string;
}

/** How much of the offending spelling a problem quotes. */
const SPELLING_MAX = 24;

/** Elements without content: they open nothing. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Elements whose start tag closes nothing in a body (the HTML standard's
 * "in body" insertion mode: phrasing and formatting elements, which only
 * nest). A value of only these, balanced, around HTML content, changes no
 * element around it, so it needs no tree reading; any other start tag (a
 * `<p>`, `<li>`, `<a>`, a heading) may close the element it lands in.
 */
const NESTING_ONLY: ReadonlySet<string> = new Set([
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "img",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

/** The HTML tokenizer's whitespace (not JS `\s`, which also matches U+00A0). */
const HTML_WS = /[\t\n\f\r ]/;

/** Characters without which a value cannot change the markup in any place (`-` ends a comment with the template's `>`). */
const MAY_BREAK = /[<>"'\t\n\f\r -]/;

/** Whether `value` holds a character that could change markup somewhere (a cheap first test). */
export function mayBreakMarkup(value: string): boolean {
  return MAY_BREAK.test(value);
}

/** ASCII-only lowercase, as the tokenizer compares tag names. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `value` from `at`, cut to {@link SPELLING_MAX} characters. */
function spellingAt(value: string, at: number, until?: number): string {
  const end = until === undefined ? at + SPELLING_MAX : Math.min(until, at + SPELLING_MAX);
  return value.slice(Math.max(0, at), Math.max(at, end));
}

/** A tag's source from `at` to its `>` (or {@link SPELLING_MAX}). */
function tagSpelling(value: string, at: number): string {
  const gt = value.indexOf(">", at);
  return spellingAt(value, at, gt === -1 ? undefined : gt + 1);
}

/**
 * The problem `value` has at `place`, or null when it leaves the markup
 * around it as it is. Never throws: a reading that cannot be made (the
 * elements around the value cannot be written back) refuses nothing.
 */
export function coreValueProblem(place: CorePlace, value: string): CoreValueProblem | null {
  switch (place.kind) {
    case "content":
      return value.includes("<") ? contentProblem(place, value) : null;
    case "raw-text":
      return rawTextProblem(place.element, value, place.after);
    case "comment":
      return commentProblem(place.atStart, value, place.after);
    case "attribute":
      return attributeProblem(place, value);
    case "tag":
      return tagProblem(place.inName, value);
  }
}

/**
 * The first problem `value` has at the value tag whose `{{` starts at
 * `offset` of the module template `html` (any of its places), or null.
 */
export function coreValueProblemAt(
  html: string,
  offset: number,
  value: string,
): CoreValueProblem | null {
  if (!mayBreakMarkup(value)) return null;
  const places = placeholderContexts(html).corePlaces.get(offset);
  if (places === undefined) return null;
  for (const place of places) {
    const problem = coreValueProblem(place, value);
    if (problem !== null) return problem;
  }
  return null;
}

// ── Element content ───────────────────────────────────────────────────

/** Where a value in element content is, in words. */
function contentPlace(place: Extract<CorePlace, { kind: "content" }>): string {
  const inner = place.open === null ? "" : /<[^<]*>$/.exec(place.open)?.[0];
  return inner ? `element content inside ${inner}` : "element content";
}

function contentProblem(
  place: Extract<CorePlace, { kind: "content" }>,
  value: string,
): CoreValueProblem | null {
  const where = contentPlace(place);
  // A mark after the value, as the browser reads the module's markup after
  // it: the value must end as text. A space first, so a trailing `<` stays
  // text (as before the module's own next tag); a tag the value leaves
  // unfinished takes the mark in.
  // A trailing `<` (or `</`, `<!`, `<?`) the template's own next letter
  // completes into a tag is no text.
  if (/<[/!?]?$/.test(value) && /^[a-zA-Z!/?]/.test(place.after)) {
    return {
      rule: "unfinished-tag",
      spelling: spellingAt(value, value.lastIndexOf("<")),
      place: where,
    };
  }
  const mark = markFor(value);
  const tokens = htmlTokens(`${value} ${mark}`, { textElements: true });
  const open: { readonly name: string; readonly at: number }[] = [];
  let nestingOnly = true;
  for (const t of tokens) {
    const problem = tokenProblem(t, value, open, where);
    if (problem !== null) return problem;
    if (t.kind === "start" && !NESTING_ONLY.has(t.name)) nestingOnly = false;
  }
  const last = tokens[tokens.length - 1];
  if (last?.kind !== "text" || !last.value.endsWith(mark)) {
    const lt = value.lastIndexOf("<");
    return { rule: "unfinished-tag", spelling: spellingAt(value, Math.max(0, lt)), place: where };
  }
  if (place.plain && nestingOnly) {
    // Phrasing elements only: their tokens are the whole story.
    const left = open[open.length - 1];
    return left === undefined
      ? null
      : { rule: `unclosed-${left.name}`, spelling: tagSpelling(value, left.at), place: where };
  }
  return place.open === null ? null : treeProblem(place.open, value, where);
}

/**
 * The problem one token of a value in element content has by itself: a
 * comment-like token, a doctype, or an end tag of an element the value did
 * not open. `open` is the value's own open elements, updated.
 */
function tokenProblem(
  t: HtmlToken,
  value: string,
  open: { readonly name: string; readonly at: number }[],
  where: string,
): CoreValueProblem | null {
  switch (t.kind) {
    case "comment": {
      const rule = value.startsWith("<!--", t.start)
        ? "comment"
        : value.startsWith("<?", t.start)
          ? "processing-instruction"
          : value.startsWith("</", t.start)
            ? "bogus-end-tag"
            : "markup-declaration";
      return { rule, spelling: spellingAt(value, t.start, t.start + 9), place: where };
    }
    case "doctype":
      return { rule: "doctype", spelling: spellingAt(value, t.start, t.start + 9), place: where };
    case "start":
      if (!VOID_ELEMENTS.has(t.name)) open.push({ name: t.name, at: t.start });
      return null;
    case "end": {
      // `</br>` is read as `<br>`: it closes nothing.
      if (t.name === "br") return null;
      let at = -1;
      for (let k = open.length - 1; k >= 0; k -= 1) {
        if (open[k]?.name === t.name) {
          at = k;
          break;
        }
      }
      if (at === -1) {
        return {
          rule: `end-tag-${ruleName(t.name)}`,
          spelling: tagSpelling(value, t.start),
          place: where,
        };
      }
      open.length = at;
      return null;
    }
    case "text":
      return null;
  }
}

/** A tag name as a rule names it: marker-safe, never empty. */
function ruleName(name: string): string {
  const safe = asciiLower(name)
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return safe.length > 0 ? safe : "x";
}

/** Letters `s` does not hold, which mark where a value ended. */
function markFor(s: string): string {
  const lower = s.toLowerCase();
  for (let n = 0; ; n += 1) {
    const mark = `qzxcoreend${n.toString(36)}zq`;
    if (!lower.includes(mark)) return mark;
  }
}

/** A parse of `open` + something, with where the innermost opened element is. */
interface FrameParse {
  readonly root: DefaultTreeAdapterTypes.DocumentFragment;
  /** The element `open`'s last start tag made; null when `open` is empty. */
  readonly innermost: Element | null;
}

/** Parse `text` as a body's content, as a browser with scripting on reads it. */
function parseBody(text: string): DefaultTreeAdapterTypes.DocumentFragment {
  const body = defaultTreeAdapter.createElement("body", H.NS.HTML, []);
  return parseFragment(body, text, { sourceCodeLocationInfo: true, scriptingEnabled: true });
}

/** The children of `node`, a template's content for a `<template>`. */
function childrenOf(node: Node): readonly Node[] {
  if ("content" in node && node.content) {
    return (node.content as DefaultTreeAdapterTypes.DocumentFragment).childNodes;
  }
  return "childNodes" in node ? (node as DefaultTreeAdapterTypes.ParentNode).childNodes : [];
}

/** Every node of `root`, without recursion (a value nested thousands deep is read, not a stack overflow). */
function* walk(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    yield node;
    const kids = childrenOf(node);
    for (let k = kids.length - 1; k >= 0; k -= 1) stack.push(kids[k] as Node);
  }
}

/** Parse `open` + `rest` and find the element `open`'s last start tag made. */
function parseInFrame(open: string, rest: string): FrameParse {
  const root = parseBody(open + rest);
  const innermostAt = open.length === 0 ? -1 : open.lastIndexOf("<");
  if (innermostAt === -1) return { root, innermost: null };
  for (const node of walk(root)) {
    if ("tagName" in node && (node as Element).sourceCodeLocation?.startOffset === innermostAt) {
      return { root, innermost: node as Element };
    }
  }
  return { root, innermost: null };
}

/** The node a value's text belongs in: the innermost element (a template's content), or the root. */
function frameTarget(parse: FrameParse): Node | null {
  const e = parse.innermost;
  if (e === null) return parse.root;
  if (e.tagName === "template" && e.namespaceURI === H.NS.HTML) {
    return (e as DefaultTreeAdapterTypes.Template).content ?? null;
  }
  return e;
}

/** The text node holding `mark`, if the parse kept it as text. */
function markText(root: Node, mark: string): DefaultTreeAdapterTypes.TextNode | null {
  for (const node of walk(root)) {
    if (
      node.nodeName === "#text" &&
      (node as DefaultTreeAdapterTypes.TextNode).value.includes(mark)
    ) {
      return node as DefaultTreeAdapterTypes.TextNode;
    }
  }
  return null;
}

const FRAME_CACHE_SIZE = 256;
/** Per `open`, whether a mark right after it is its innermost element's text (the reading holds). */
const frameHolds = new Map<string, boolean>();

/** Whether text written right after `open` lands in `open`'s innermost element. */
function frameReadsBack(open: string): boolean {
  const hit = frameHolds.get(open);
  if (hit !== undefined) return hit;
  const mark = markFor(open);
  const parse = parseInFrame(open, ` ${mark}`);
  const text = markText(parse.root, mark);
  const holds =
    (open.length === 0 || parse.innermost !== null) &&
    text !== null &&
    text.parentNode === frameTarget(parse);
  frameHolds.set(open, holds);
  if (frameHolds.size > FRAME_CACHE_SIZE) {
    const oldest = frameHolds.keys().next().value;
    if (oldest !== undefined) frameHolds.delete(oldest);
  }
  return holds;
}

/**
 * Read `value` inside the elements the module puts around it, followed by
 * a mark: the mark must land as text of the innermost of them, as it does
 * without the value. Where it lands otherwise says what the value did: an
 * element of its own still open around the mark, or the module's element
 * closed by a token of the value (parse5 ends an element where the token
 * that closed it starts).
 */
function treeProblem(open: string, value: string, where: string): CoreValueProblem | null {
  if (!frameReadsBack(open)) return null;
  const mark = markFor(open + value);
  // A space before the mark: a trailing `<` stays text, as before the
  // module's own next tag; a value ending inside a tag keeps the mark there.
  const parse = parseInFrame(open, `${value} ${mark}`);
  const target = frameTarget(parse);
  const text = markText(parse.root, mark);
  if (text !== null && text.parentNode === target) return null;
  const from = open.length;
  const to = open.length + value.length;
  if (text === null) {
    const lt = value.lastIndexOf("<");
    return { rule: "unfinished-tag", spelling: spellingAt(value, Math.max(0, lt)), place: where };
  }
  // The module's element, closed by a token of the value.
  const closed = parse.innermost?.sourceCodeLocation?.endOffset;
  if (parse.innermost && closed !== undefined && closed >= from && closed < to) {
    const at = closed - from;
    const tag = /^<\/?([a-zA-Z][^\t\n\f\r />]*)/.exec(value.slice(at));
    if (tag && value[at + 1] === "/") {
      return {
        rule: `end-tag-${ruleName(tag[1] as string)}`,
        spelling: tagSpelling(value, at),
        place: where,
      };
    }
    return {
      rule: `closes-${ruleName(parse.innermost.tagName)}`,
      spelling: tagSpelling(value, at),
      place: where,
    };
  }
  // The innermost element the value opened that holds the mark.
  for (let n: Node | null = text.parentNode; n !== null && n !== target; n = parentOf(n)) {
    if (!("tagName" in n)) continue;
    const at = (n as Element).sourceCodeLocation?.startOffset;
    if (at !== undefined && at >= from && at < to) {
      return {
        rule: `unclosed-${ruleName((n as Element).tagName)}`,
        spelling: tagSpelling(value, at - from),
        place: where,
      };
    }
  }
  const first = value.indexOf("<");
  return {
    rule: "breaks-structure",
    spelling: tagSpelling(value, Math.max(0, first)),
    place: where,
  };
}

/** A node's parent; a template's content leads back to nothing (the walk stops at the target). */
function parentOf(n: Node): Node | null {
  return ("parentNode" in n ? (n.parentNode as Node | null) : null) ?? null;
}

// ── Raw text, comments, attributes, tags ──────────────────────────────

/**
 * An end tag of `element` that starts in `value`: completed by the value
 * or by the template's text after it (`after`), or by whatever the end of
 * that text leaves open (a following tag's value): `</textarea` before the
 * template's `>` ends the element too.
 */
function rawTextProblem(element: string, value: string, after: string): CoreValueProblem | null {
  const where = `the text of <${element}>`;
  // Nothing ends a `<plaintext>`.
  if (element === "plaintext") return null;
  const read = asciiLower(value + after);
  const end = `</${element}`;
  for (let at = read.indexOf(end); at !== -1 && at < value.length; at = read.indexOf(end, at + 1)) {
    const next = read[at + end.length];
    if (next === undefined || HTML_WS.test(next) || next === "/" || next === ">") {
      return {
        rule: `ends-${ruleName(element)}`,
        spelling: spellingAt(value, at, at + end.length + 1),
        place: where,
      };
    }
  }
  if (element === "script") {
    const at = (value + after).indexOf("<!--");
    if (at !== -1 && at < value.length) {
      return { rule: "script-comment", spelling: "<!--", place: where };
    }
  }
  return null;
}

/** A comment's end that starts in `value`, completed by it or by the template's text after it. */
function commentProblem(atStart: boolean, value: string, after: string): CoreValueProblem | null {
  const where = "a comment";
  const ends = /--!?>/g;
  for (let m = ends.exec(value + after); m !== null; m = ends.exec(value + after)) {
    if (m.index < value.length) return { rule: "ends-comment", spelling: m[0], place: where };
  }
  if (atStart && (value.startsWith(">") || value.startsWith("->"))) {
    return { rule: "ends-comment", spelling: value.startsWith(">") ? ">" : "->", place: where };
  }
  return null;
}

function attributeProblem(
  place: Extract<CorePlace, { kind: "attribute" }>,
  value: string,
): CoreValueProblem | null {
  if (place.quote !== null) {
    const at = value.indexOf(place.quote);
    return at === -1
      ? null
      : {
          rule: "attribute-quote",
          spelling: place.quote,
          place: `a ${place.quote}-quoted attribute value`,
        };
  }
  const where = "an unquoted attribute value";
  if (place.atStart && (value.startsWith('"') || value.startsWith("'"))) {
    return { rule: "attribute-quote", spelling: value[0] as string, place: where };
  }
  for (const ch of value) {
    if (ch === ">") return { rule: "attribute-end", spelling: ">", place: where };
    if (HTML_WS.test(ch)) return { rule: "attribute-space", spelling: ch, place: where };
  }
  return null;
}

function tagProblem(inName: boolean, value: string): CoreValueProblem | null {
  if (inName) {
    const at = value.search(/[\t\n\f\r />]/);
    return at === -1
      ? null
      : { rule: "ends-tag-name", spelling: spellingAt(value, at, at + 1), place: "a tag's name" };
  }
  // The value must stay one tag's attributes: the same start tag, and the
  // text after it, read exactly as without it.
  const mark = markFor(value);
  const tokens = htmlTokens(`<x ${value} y>${mark}`);
  const [tag, text] = tokens;
  if (
    tokens.length === 2 &&
    tag?.kind === "start" &&
    text?.kind === "text" &&
    text.value === mark
  ) {
    return null;
  }
  const at = value.search(/[>"']/);
  return {
    rule: "ends-tag",
    spelling: spellingAt(value, at === -1 ? 0 : at, at === -1 ? undefined : at + 1),
    place: "a tag's attributes",
  };
}
