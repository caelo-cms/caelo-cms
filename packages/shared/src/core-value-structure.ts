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
 */

import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as H, parseFragment } from "parse5";
import { type HtmlToken, htmlTokens } from "./html-tokens.js";
import type { ListItem } from "./lists/items.js";
import { stripCdataGuards } from "./strip-cdata.js";
import { type CorePlace, placeholderContexts } from "./template-contexts.js";
import {
  contextValueTags,
  type ModuleValueTag,
  moduleValueTags,
  sectionValueTags,
} from "./template-sections.js";

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

/** Characters without which a value cannot change the markup in any place. */
const MAY_BREAK = /[<>"'\t\n\f\r ]/;

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
      return rawTextProblem(place.element, value);
    case "comment":
      return commentProblem(place.atStart, value);
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
  const mark = markFor(value);
  const tokens = htmlTokens(`${value} ${mark}`);
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

function rawTextProblem(element: string, value: string): CoreValueProblem | null {
  const where = `the text of <${element}>`;
  // Nothing ends a `<plaintext>`.
  if (element === "plaintext") return null;
  const lower = asciiLower(value);
  const end = `</${element}`;
  for (let at = lower.indexOf(end); at !== -1; at = lower.indexOf(end, at + 1)) {
    const next = value[at + end.length];
    if (next !== undefined && (HTML_WS.test(next) || next === "/" || next === ">")) {
      return {
        rule: `ends-${ruleName(element)}`,
        spelling: spellingAt(value, at, at + end.length + 1),
        place: where,
      };
    }
  }
  if (element === "script") {
    const at = value.indexOf("<!--");
    if (at !== -1) return { rule: "script-comment", spelling: "<!--", place: where };
  }
  return null;
}

function commentProblem(atStart: boolean, value: string): CoreValueProblem | null {
  const where = "a comment";
  const end = /--!?>/.exec(value);
  if (end !== null) return { rule: "ends-comment", spelling: end[0], place: where };
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

// ── Markers and messages ──────────────────────────────────────────────

/**
 * The render failure marker of a core value that breaks the markup around
 * it: `value-breaks-markup:<field>:<rule>`. `field` names where the value
 * comes from: a module field (`title`), a list entry (`ui_texts[<item
 * id>].text`), the page (`page.title`) or a site text (`site_text.<key>`).
 */
export function valueBreaksMarkupMarker(field: string, rule: string): string {
  return `${VALUE_BREAKS_MARKUP}:${field}:${rule}`;
}

/** The parts of a {@link VALUE_BREAKS_MARKUP} marker's body (what follows the kind). */
export function parseValueBreaksMarkup(body: string): {
  readonly field: string;
  readonly rule: string;
} {
  const at = body.lastIndexOf(":");
  return at < 0
    ? { field: body, rule: "" }
    : { field: body.slice(0, at), rule: body.slice(at + 1) };
}

/** True for a {@link VALUE_BREAKS_MARKUP} marker. */
export function isValueBreaksMarkupMarker(marker: string): boolean {
  return marker.startsWith(`${VALUE_BREAKS_MARKUP}:`);
}

/** What a rule's spelling does, in the AI's words. */
export function valueBreaksMarkupEffect(rule: string, spelling: string): string {
  const s = spelling.length > 0 ? `\`${spelling}\`` : "it";
  if (rule === "comment")
    return `${s} starts a comment that hides what follows up to the next \`-->\``;
  if (
    rule === "processing-instruction" ||
    rule === "markup-declaration" ||
    rule === "bogus-end-tag"
  ) {
    return `${s} starts a bogus comment that hides what follows up to the next \`>\` (the module's own markup included)`;
  }
  if (rule === "doctype") return `${s} is a doctype`;
  if (rule.startsWith("end-tag-")) return `${s} closes an element the value did not open`;
  if (rule.startsWith("unclosed-"))
    return `${s} is never closed, so the module's markup after the value lands inside it`;
  if (rule.startsWith("closes-")) {
    return `${s} closes the <${rule.slice("closes-".length)}> the module places the value in`;
  }
  if (rule === "unfinished-tag")
    return `${s} leaves a tag unfinished, which takes in the module's markup after it`;
  if (rule === "script-comment")
    return `${s} in a script can keep the module's \`</script>\` from ending it`;
  if (
    rule.startsWith("ends-") &&
    rule !== "ends-comment" &&
    rule !== "ends-tag" &&
    rule !== "ends-tag-name"
  ) {
    return `${s} ends the module's <${rule.slice("ends-".length)}> early`;
  }
  if (rule === "ends-comment") return `${s} ends the module's comment early`;
  if (rule === "attribute-quote") return `${s} ends the attribute value early`;
  if (rule === "attribute-space" || rule === "attribute-end")
    return "it ends the unquoted attribute value early";
  if (rule === "ends-tag" || rule === "ends-tag-name") return `${s} ends the tag early`;
  return `${s} changes the markup around the value`;
}

/** How to write the value instead, for a rule. */
export function valueBreaksMarkupFix(rule: string, spelling: string): string {
  const asText = spelling.replaceAll("<", "&lt;");
  if (rule === "attribute-quote") {
    return spelling === "'" ? "Write the ' as &#39;." : 'Write the " as &quot;.';
  }
  if (rule === "attribute-space" || rule === "attribute-end") {
    return 'Quote the attribute in the module HTML (attr="{{field}}"), or write a space as &#32; and > as &gt;.';
  }
  if (rule === "ends-script" || rule === "ends-style" || rule === "script-comment") {
    return "In script or CSS text write `<\\/` for `</` and `<\\!--` for `<!--`.";
  }
  if (
    rule.startsWith("ends-") &&
    rule !== "ends-comment" &&
    rule !== "ends-tag" &&
    rule !== "ends-tag-name"
  ) {
    return "Write the `<` of it as &lt;.";
  }
  if (rule === "ends-comment") return "Write the > of it as &gt;.";
  if (rule === "ends-tag" || rule === "ends-tag-name") {
    return "Write the > as &gt; and keep quotes paired.";
  }
  if (rule.startsWith("unclosed-")) {
    return `Close it inside the value, or write ${asText.length > 0 ? `\`${asText}\`` : "its <"} if it is text (a < meant as text is &lt;).`;
  }
  if (rule.startsWith("closes-")) {
    return `Leave that tag out of the value (the module already places it in a <${rule.slice("closes-".length)}>), or write \`${asText}\` if it is text.`;
  }
  return `Write a < meant as text as &lt;${asText.length > 0 ? ` (here \`${asText}\`)` : ""}.`;
}

/**
 * The refusal of one breaking value, for a write's error (CLAUDE.md §11):
 * what it holds, why it breaks where the module places it, what to write.
 *
 * @param where the value in the caller's terms (`field "text" of list entry <id>`).
 * @param module the module whose HTML places it (its slug), when the caller knows it.
 */
export function describeValueBreaksMarkup(
  where: string,
  problem: CoreValueProblem,
  module?: string,
): string {
  const html = module === undefined ? "the module HTML" : `module "${module}"`;
  return `${where} holds \`${problem.spelling}\`: in ${problem.place} of ${html} ${valueBreaksMarkupEffect(problem.rule, problem.spelling)}. ${valueBreaksMarkupFix(problem.rule, problem.spelling)}`;
}

// ── Write time ────────────────────────────────────────────────────────

/** A stored value that breaks the markup where a module places it. */
export interface StoredValueProblem {
  /** Where the value is in what the write stored (`["title"]`, `["nav", 2, "values", "label"]`). */
  readonly path: readonly (string | number)[];
  /** The value's name in the caller's terms (`title`, `label` of entry 2 of `nav`). */
  readonly where: string;
  readonly problem: CoreValueProblem;
}

/** The string a value renders as at a `{{name}}` (`path` `href`/`title` of a link), or null. */
function renderedString(value: unknown, key: "" | "href" | "title"): string | null {
  if (key === "" && typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = (value as Record<string, unknown>)[key === "" ? "href" : key];
  return typeof v === "string" ? v : null;
}

/** The first problem `value` has at any of `tags`, or null. */
function firstProblem(html: string, tags: readonly ModuleValueTag[], value: string) {
  for (const t of tags) {
    const problem = coreValueProblemAt(html, t.start, value);
    if (problem !== null) return problem;
  }
  return null;
}

/** Tags by the name they read (`label`; `link` and `link.href` both read a link's href). */
function tagsByName(tags: readonly ModuleValueTag[]): Map<string, ModuleValueTag[]> {
  const out = new Map<string, ModuleValueTag[]>();
  for (const t of tags) out.set(t.name, [...(out.get(t.name) ?? []), t]);
  return out;
}

/**
 * #1748 — the entries of a list (local or shared) that break the markup
 * where module `html` renders them: the value tags of every
 * `{{#field}}…{{/field}}` section, the entries' children included. An
 * entry `previous` holds with the same value is not this write's doing and
 * passes (a Stage still reports it).
 *
 * @param at the path of the list's entries in what the write stored.
 * @param label the list in the caller's terms (default: `list "<field>"`).
 */
export function listEntryValueProblems(
  moduleHtml: string,
  field: string,
  items: readonly ListItem[],
  at: readonly (string | number)[],
  previous?: readonly ListItem[],
  label = `list "${field}"`,
): StoredValueProblem[] {
  // Read as the engine reads it (template-engine.ts unwraps CDATA guards first).
  const html = stripCdataGuards(moduleHtml);
  const tags = tagsByName(sectionValueTags(html, field));
  if (tags.size === 0) return [];
  const before = new Map<string, ListItem>();
  const index = (list: readonly ListItem[] | undefined) => {
    for (const item of list ?? []) {
      before.set(item.id, item);
      index(item.children);
    }
  };
  index(previous);
  const out: StoredValueProblem[] = [];
  const visit = (list: readonly ListItem[], path: readonly (string | number)[]) => {
    for (const [i, item] of list.entries()) {
      const old = before.get(item.id);
      for (const [key, value] of Object.entries(item.values ?? {})) {
        if (old !== undefined && JSON.stringify(old.values?.[key]) === JSON.stringify(value))
          continue;
        const k = key.toLowerCase();
        for (const [name, part] of [
          [k, ""],
          [`${k}.href`, "href"],
          [`${k}.title`, "title"],
        ] as const) {
          const at = tags.get(name);
          const text = at ? renderedString(value, part) : null;
          const problem = at && text !== null ? firstProblem(html, at, text) : null;
          if (problem === null) continue;
          out.push({
            path: [...path, i, "values", key],
            where: `"${key}" of entry ${item.id} of ${label}`,
            problem,
          });
          break;
        }
      }
      if (item.children) visit(item.children, [...path, i, "children"]);
    }
  };
  visit(items, at);
  return out;
}

/**
 * #1748 — the values of a module's fields (a content instance's values, or
 * the fields' defaults) that break the markup where its HTML places them:
 * a field's value at every `{{field}}` outside list entries, a local
 * list's entries at the tags of its section. A list value that names a
 * shared list (`caelo:list/<id>`) is that list's to check. A value
 * `previous` holds unchanged passes (see {@link listEntryValueProblems}).
 */
export function moduleValueProblems(
  moduleHtml: string,
  fields: readonly { readonly name: string; readonly kind?: string }[],
  values: Readonly<Record<string, unknown>>,
  previous?: Readonly<Record<string, unknown>>,
): StoredValueProblem[] {
  const html = stripCdataGuards(moduleHtml);
  const kinds = new Map(fields.map((f) => [f.name.toLowerCase(), { kind: f.kind ?? "text" }]));
  const byName = tagsByName(moduleValueTags(html, kinds, true));
  const out: StoredValueProblem[] = [];
  for (const [key, value] of Object.entries(values)) {
    const was = previous?.[key];
    if (Array.isArray(value)) {
      if (kinds.get(key.toLowerCase())?.kind !== "list") continue;
      const items = value.filter(isListItem);
      const old = Array.isArray(was) ? was.filter(isListItem) : undefined;
      out.push(...listEntryValueProblems(moduleHtml, key, items, [key], old));
      continue;
    }
    if (previous !== undefined && JSON.stringify(was) === JSON.stringify(value)) continue;
    const k = key.toLowerCase();
    for (const [name, part] of [
      [k, ""],
      [`${k}.href`, "href"],
      [`${k}.title`, "title"],
    ] as const) {
      const tags = byName.get(name);
      const text = tags ? renderedString(value, part) : null;
      const problem = tags && text !== null ? firstProblem(html, tags, text) : null;
      if (problem === null) continue;
      out.push({ path: part === "" ? [key] : [key, part], where: `field "${key}"`, problem });
      break;
    }
  }
  return out;
}

/**
 * #1748 — the site texts (`key` → text) that break the markup where
 * module `html` reads them with `{{site_text.<key>}}`.
 */
export function siteTextValueProblems(
  moduleHtml: string,
  texts: ReadonlyMap<string, string>,
): { readonly key: string; readonly problem: CoreValueProblem }[] {
  const html = stripCdataGuards(moduleHtml);
  const out: { key: string; problem: CoreValueProblem }[] = [];
  const seen = new Set<string>();
  for (const t of contextValueTags(html, "site_text")) {
    const key = t.name.slice("site_text.".length);
    const text = texts.get(key);
    if (text === undefined || seen.has(key)) continue;
    const problem = coreValueProblemAt(html, t.start, text);
    if (problem === null) continue;
    seen.add(key);
    out.push({ key, problem });
  }
  return out;
}

function isListItem(v: unknown): v is ListItem {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { values?: unknown }).values === "object"
  );
}

/** The spelling a rule names, for a marker that does not carry it (a Stage's report). */
function ruleSpelling(rule: string): string {
  if (rule === "processing-instruction") return "<?";
  if (rule === "comment" || rule === "script-comment") return "<!--";
  if (rule === "markup-declaration") return "<!";
  if (rule === "bogus-end-tag") return "</";
  if (rule === "doctype") return "<!DOCTYPE";
  if (rule === "ends-comment") return "-->";
  if (rule === "attribute-quote") return '"';
  if (rule === "attribute-end" || rule === "ends-tag" || rule === "ends-tag-name") return ">";
  if (rule === "unfinished-tag") return "<";
  if (rule.startsWith("end-tag-")) return `</${rule.slice("end-tag-".length)}>`;
  if (rule.startsWith("unclosed-")) return `<${rule.slice("unclosed-".length)}>`;
  if (rule.startsWith("ends-")) return `</${rule.slice("ends-".length)}`;
  return "";
}

/**
 * #1748 — how the AI repairs a {@link VALUE_BREAKS_MARKUP} failure, by
 * where the value comes from: the tool, and the hint the Stage's report,
 * the audit's finding and the preview's next steps all give.
 *
 * @param body the marker without its kind (`<field>:<rule>`).
 * @param mod the place in the AI's terms (`module "hero"`).
 */
export function valueBreaksMarkupRepair(
  body: string,
  mod: string,
): { readonly tool: string; readonly hint: string } {
  const { field, rule } = parseValueBreaksMarkup(body);
  const spelling = ruleSpelling(rule);
  const effect = valueBreaksMarkupEffect(rule, spelling);
  const fix = valueBreaksMarkupFix(rule, spelling);
  const entry = /^([a-z0-9_]+)\[([^\]]+)\]\.(.+)$/.exec(field);
  let what: string;
  let tool: string;
  if (field.startsWith("site_text.")) {
    tool = "patch_list_items_many";
    what = `the site text "${field.slice("site_text.".length)}" (site-texts list)`;
  } else if (field.startsWith("page.")) {
    tool = "update_pages_many";
    what = `the page's ${field.slice("page.".length)}`;
  } else if (entry) {
    tool = "patch_list_items_many";
    what = `"${entry[3]}" of entry ${entry[2]} of list field "${entry[1]}" (shared list: patch_list_items_many; local: set_content_instance_values_many)`;
  } else {
    tool = "set_content_instance_values_many";
    what = `field "${field}" (its default: update_modules_many)`;
  }
  // The fix first: a finding's hint is cut at 500 characters.
  return {
    tool,
    hint: `${fix} Value: ${what} in ${mod}, where ${effect} (${rule}); it renders as written until fixed. Then Stage again.`,
  };
}
