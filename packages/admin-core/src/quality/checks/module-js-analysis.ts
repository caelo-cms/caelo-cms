// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — what a module's JS does to the page, read from its source.
 *
 * Two questions, both shared by the write-time hint (ai/tools/_module-js-guard.ts)
 * and the Stage check (structure-js.ts):
 *
 * 1. Whose markup does the JS drive? The composer emits every module's `js`
 *    into ONE shared script per page, so nothing stops a header from
 *    carrying the demo form's submit handler — it loads on every page, and
 *    the header then shares the form's fate (the consent-manager scans
 *    modules one by one, so the form's CRM endpoint held back the menu).
 *    The JS's DOM hooks are every string literal that IS a CSS selector
 *    (`.class`, `#id`, `[data-*]`) plus the bare arguments of
 *    `getElementById` / `getElementsByClassName`. Scanning literals rather
 *    than tracing call arguments also catches selectors kept in a constant
 *    or an array first; a selector assembled at runtime (`'.' + name`) is
 *    not resolved (out of scope on #1198).
 *
 * 2. Does the JS build content? Content must be in the HTML source:
 *    search engines and LLM crawlers do not run JS. Showing or hiding
 *    markup that is already there is fine; writing markup that carries
 *    text, links or interpolated data into `innerHTML` & co., or rendering
 *    the entries of a content array, is not. Long literal text written
 *    into `textContent` is reported softer: it may be a status message,
 *    but it still belongs in the HTML, hidden until shown.
 *
 * A deliberate site-wide script (scroll reveal on `[data-reveal]` across
 * many modules) says so in a comment, `caelo:site-wide: <reason>`. The
 * check verifies the claim (foreignHooks, module-js-hooks.ts): a site-wide script may use
 * shared hooks only (rendered by three or more modules), never the hooks
 * of one or two modules.
 */

import { parseSync } from "oxc-parser";
import { isNode, JsScopes, type Node, nodes } from "./module-js-ast.js";

/** What one module's JS references and writes. */
export interface ModuleJsFacts {
  /** DOM hooks the JS references: `.class`, `#id`, `[data-name]`. */
  readonly hooks: readonly string[];
  /** The reason of a `caelo:site-wide:` comment, or null. */
  readonly siteWide: string | null;
  /** Ways the JS builds visible content (markup with text, content arrays). */
  readonly rendersContent: readonly string[];
  /** Long literal text the JS writes into the page. */
  readonly writesText: readonly string[];
}

const NO_FACTS: ModuleJsFacts = { hooks: [], siteWide: null, rendersContent: [], writesText: [] };

/** Entries an array needs before it counts as content data. */
export const MIN_CONTENT_ENTRIES = 3;
/** Literal text at or above this many words is content, not a UI label. */
const MIN_TEXT_WORDS = 6;
/** …or at or above this many characters. */
const MIN_TEXT_CHARS = 50;
/** Longest excerpt a description quotes. */
const MAX_EXCERPT = 60;

const MARKUP_SINK_PROPS = new Set(["innerHTML", "outerHTML"]);
const TEXT_SINK_PROPS = new Set(["textContent", "innerText"]);
const TEXT_SINK_CALLS = new Set(["append", "prepend", "replaceChildren", "after", "before"]);
/** Calls that put DOM nodes into the page. */
const DOM_INSERT_CALLS = new Set([
  "appendChild",
  "insertBefore",
  "insertAdjacentElement",
  "insertAdjacentHTML",
  "replaceWith",
  ...TEXT_SINK_CALLS,
]);

/** The non-computed property name of a member expression, or null. */
function memberName(n: unknown): string | null {
  if (!isNode(n) || n.type !== "MemberExpression" || n.computed === true) return null;
  const p = n.property;
  return isNode(p) && p.type === "Identifier" ? (p.name as string) : null;
}

function stringLiteral(n: unknown): string | null {
  return isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : null;
}

/** Stands for an interpolated value in reconstructed text. */
const HOLE = "\uE000";

/** Longest chain of string bindings followed (`a = b + "x"`, `b = c`, …). */
const MAX_BINDING_DEPTH = 8;

/** The string a declaration binds (`const markup = "<p>…</p>"`), or null. */
function boundString(decl: Node | null): Node | null {
  if (decl === null || decl.type !== "VariableDeclarator" || !isNode(decl.init)) return null;
  const init = decl.init;
  return stringLiteral(init) !== null ||
    init.type === "TemplateLiteral" ||
    (init.type === "BinaryExpression" && init.operator === "+")
    ? init
    : null;
}

/**
 * The static text of an expression, with `\uE000` where a value is
 * interpolated: literals, template parts, `+` chains, string bindings, both
 * branches of a conditional, and template literals returned from callbacks
 * (`items.map((i) => \`<li>${i.label}</li>\`).join("")`).
 */
function staticText(expr: unknown, scopes: JsScopes | null = null, depth = 0): string {
  const parts: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isNode(v)) return;
    if (v.type === "TemplateLiteral") {
      // Quasis and expressions interleaved, as the template evaluates:
      // `<use href="#${name}">` keeps `name` inside the tag.
      const quasis = v.quasis as { value: { cooked: string | null } }[];
      const exprs = v.expressions as unknown[];
      let text = "";
      quasis.forEach((q, i) => {
        text += q.value.cooked ?? "";
        if (i < exprs.length) text += staticText(exprs[i], scopes, depth) || HOLE;
      });
      parts.push(text);
      return;
    }
    if (v.type === "Identifier") {
      const bound = scopes !== null ? boundString(scopes.resolve(v)) : null;
      if (bound && depth < MAX_BINDING_DEPTH) parts.push(staticText(bound, scopes, depth + 1));
      return;
    }
    const s = stringLiteral(v);
    if (s !== null) {
      parts.push(s);
      return;
    }
    for (const [key, child] of Object.entries(v)) {
      if (key !== "type" && typeof child === "object" && child !== null) visit(child);
    }
  };
  visit(expr);
  // Pieces of one expression are concatenated at runtime; a value between
  // them (`a + x + b`) is interpolated data.
  return parts.join(HOLE);
}

/**
 * The texts an expression can write: each branch of a conditional on its
 * own (`open ? "Menü schließen" : "Menü öffnen"` is two short labels, not
 * one long text).
 */
function variants(expr: unknown, scope: JsScopes): string[] {
  if (isNode(expr) && expr.type === "ConditionalExpression") {
    return [...variants(expr.consequent, scope), ...variants(expr.alternate, scope)];
  }
  if (isNode(expr) && expr.type === "LogicalExpression") {
    return [...variants(expr.left, scope), ...variants(expr.right, scope)];
  }
  return [staticText(expr, scope)];
}

/** Visible text left when tags are removed (interpolations dropped). */
function textOutsideTags(markup: string): string {
  return stripTags(markup)
    .replace(/\uE000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tags whose inner value is page content (a heading, a list entry, a link…). */
const CONTENT_TAG_RE = /<(?:a|li|h[1-6]|p|td|th|dt|dd|figcaption|blockquote|option)[\s>]/i;

/**
 * Why a markup write builds content, or null when it only moves existing
 * markup or writes decoration (an icon).
 */
function markupContent(text: string): string | null {
  if (!/<[a-z]/i.test(text)) return null;
  if (hasAnchorLink(text)) return "links";
  // One word is a control label (`<span>Close</span>`); two are copy.
  if (wordCount(textOutsideTags(text)) >= 2) return "text";
  // `<li>${item.label}</li>`: the tag wraps an interpolated value.
  if (CONTENT_TAG_RE.test(text) && /\uE000/.test(stripTags(text))) return "data";
  return null;
}

/**
 * An `<a href>` in markup. Only anchors: `<use href="#icon">` in an SVG
 * sprite and `<link href>` reference resources, they are no navigation.
 */
function hasAnchorLink(markup: string): boolean {
  for (const part of markup.split("<").slice(1)) {
    const end = part.indexOf(">");
    const tag = end === -1 ? part : part.slice(0, end);
    if (/^a[\s\uE000]/i.test(tag) && /\shref\s*=/i.test(tag)) return true;
  }
  return false;
}

function stripTags(markup: string): string {
  let out = "";
  let inTag = false;
  for (const ch of markup) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** Words of two or more letters. */
function wordCount(s: string): number {
  return (s.match(/\p{L}{2,}/gu) ?? []).length;
}

/**
 * Reads as text for a visitor rather than a code token: a word that starts
 * upper case or with a non-ASCII letter (`Produkte`, `Über uns`), or two
 * words (`free tools`). `is-open`, `submit`, `translateY(20px)` and
 * `0.3s ease` are tokens.
 */
export function isVisitorText(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || /^[.#[<]/.test(t)) return false;
  // `card-one`, `is_open`, `step2`: ids, classes and keys, never copy.
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(t)) return false;
  if (/(?:^|[\s"'(])[\p{Lu}][\p{L}]/u.test(t)) return true;
  if (/[^\p{ASCII}]/u.test(t) && /\p{L}{2,}/u.test(t)) return true;
  return wordCount(t) >= 2 && !/^[\w-]+\(.*\)$/.test(t);
}

function isLink(s: string): boolean {
  return /^(?:\/[\w-]|https?:\/\/)/.test(s.trim());
}

/** Is this string a CSS selector a script would hand to the DOM? */
function isSelector(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 500) return false;
  if (!/^[.#[]|^[a-z*][\w-]*[\s.#[>:,]/i.test(t)) return false;
  if (!/[.#[]/.test(t)) return false;
  return /^[\s\w\-.#[\]=~^$*|"':(),>+]+$/.test(t);
}

/** The class / id / data-attribute hooks of one selector. */
function selectorHooks(selector: string): string[] {
  const out: string[] = [];
  // Attribute values are not hooks (`[href="#top"]` names no id), and a
  // negation excludes elements (`.product:not(.admin-only)` drives no
  // `.admin-only`).
  let bare = selector.replace(/"[^"]*"|'[^']*'/g, '""');
  for (let prev = ""; prev !== bare; ) {
    prev = bare;
    bare = bare.replace(/:not\([^()]*\)/gi, "");
  }
  for (const m of bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.push(`.${m[1]}`);
  for (const m of bare.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) out.push(`#${m[1]}`);
  for (const m of bare.matchAll(/\[\s*(data-[\w-]+)/g)) out.push(`[${m[1]}]`);
  return out;
}

function excerpt(s: string): string {
  const t = s
    .replace(/\uE000/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > MAX_EXCERPT ? `${t.slice(0, MAX_EXCERPT)}…` : t;
}

/** An array literal of content entries: its size and a sample, or null. */
function contentArray(n: Node): { count: number; sample: string[] } | null {
  const elements = (n.elements as unknown[]).filter(isNode);
  if (elements.length < MIN_CONTENT_ENTRIES) return null;
  const sample: string[] = [];
  let entries = 0;
  for (const el of elements) {
    const values =
      el.type === "ObjectExpression"
        ? (el.properties as unknown[]).flatMap((p) =>
            isNode(p) && p.type === "Property" ? [stringLiteral(p.value)] : [],
          )
        : [stringLiteral(el)];
    const content = values.filter(
      (v): v is string => v !== null && (isVisitorText(v) || isLink(v)),
    );
    if (content.length > 0) {
      entries++;
      if (sample.length < 3) sample.push(excerpt(content[0] as string));
    }
  }
  return entries >= MIN_CONTENT_ENTRIES ? { count: entries, sample } : null;
}

const SITE_WIDE_RE = /caelo:site-wide\s*:?\s*([^\n]*)/;

/**
 * Analyse one module's JS. JS that does not parse yields no facts: the
 * module write refuses it already (ops/content/module-js-syntax.ts).
 */
export function analyseModuleJs(js: string): ModuleJsFacts {
  if (js.trim().length === 0) return NO_FACTS;
  const parsed = parseSync("module.js", js, { sourceType: "script" });
  if (parsed.errors.some((e) => e.severity === "Error")) return NO_FACTS;

  let siteWide: string | null = null;
  for (const c of parsed.comments) {
    const m = SITE_WIDE_RE.exec(c.value);
    if (m) siteWide = (m[1] ?? "").replace(/\*\/?$/, "").trim();
  }

  const hooks = new Set<string>();
  const rendersContent: string[] = [];
  const writesText: string[] = [];
  const arrays = new Map<Node, { count: number; sample: string[] }>();
  const bindings = new Map<Node, { name: string; viaProperty: boolean }>();
  const scope = new JsScopes(parsed.program as unknown as Node);
  const rendered = new Rendered(scope);

  for (const n of nodes(parsed.program)) {
    const s = stringLiteral(n);
    if (s !== null && isSelector(s)) for (const h of selectorHooks(s)) hooks.add(h);
    if (n.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0) {
      const t = staticText(n);
      if (isSelector(t)) for (const h of selectorHooks(t)) hooks.add(h);
    }

    if (n.type === "CallExpression") {
      const name = memberName(n.callee);
      const args = n.arguments as unknown[];
      const first = stringLiteral(args[0]);
      if (name === "getElementById" && first) hooks.add(`#${first.trim()}`);
      if (name === "getElementsByClassName" && first) {
        for (const c of first.trim().split(/\s+/)) if (c) hooks.add(`.${c}`);
      }
      const markupArg =
        name === "insertAdjacentHTML"
          ? args[1]
          : name === "createContextualFragment" || name === "setHTMLUnsafe"
            ? args[0]
            : name === "write" || name === "writeln"
              ? isDocument(n.callee)
                ? args[0]
                : undefined
              : undefined;
      if (markupArg !== undefined) {
        rendered.addSubtree(markupArg);
        for (const t of variants(markupArg, scope))
          noteMarkup(`${name}()`, t, rendersContent, writesText);
      }
      if (
        (name !== null && TEXT_SINK_CALLS.has(name) && !isDataReceiver(n.callee, scope)) ||
        name === "createTextNode"
      ) {
        rendered.addSubtree(args);
        for (const a of args)
          for (const t of variants(a, scope)) noteText(t, writesText, rendersContent);
      }
      // `items.forEach((i) => { …appendChild… })`: the iterated array is rendered.
      if (name !== null && ITERATE_CALLS.has(name) && args.some((a) => containsSink(a, scope))) {
        rendered.add((n.callee as Node).object);
      }
    }

    if (n.type === "AssignmentExpression") {
      const prop = memberName(n.left);
      if (prop !== null && MARKUP_SINK_PROPS.has(prop)) {
        rendered.addSubtree(n.right);
        for (const t of variants(n.right, scope)) noteMarkup(prop, t, rendersContent, writesText);
      } else if (prop !== null && TEXT_SINK_PROPS.has(prop)) {
        rendered.addSubtree(n.right);
        for (const t of variants(n.right, scope)) noteText(t, writesText, rendersContent);
      }
    }

    // `for (const i of items) …` / `for (…; i < items.length; …) items[i]` with a sink inside.
    if (n.type === "ForOfStatement" && containsSink(n.body, scope)) rendered.add(n.right);
    if ((n.type === "ForStatement" || n.type === "WhileStatement") && containsSink(n.body, scope)) {
      for (const m of nodes(n.body)) {
        if (m.type === "MemberExpression" && m.computed === true) rendered.add(m.object);
      }
    }

    if (n.type === "ArrayExpression") {
      const a = contentArray(n);
      if (a) arrays.set(n, a);
    }
    const bound = bindingOfArray(n);
    if (bound) bindings.set(bound.array, { name: bound.name, viaProperty: bound.viaProperty });
  }

  // Data in an array is rendered content only when the script puts its
  // entries into the page; an array of analytics labels next to an
  // unrelated `textContent` write is not.
  for (const [node, a] of arrays) {
    const b = bindings.get(node);
    const reached =
      rendered.nodes.has(node) ||
      (b !== undefined && (b.viaProperty ? rendered.names.has(b.name) : rendered.decls.has(node)));
    if (!reached) continue;
    rendersContent.push(
      `renders ${a.count} entries from a JS array (${a.sample.map((x) => `"${x}"`).join(", ")}, …)`,
    );
  }

  return { hooks: [...hooks].sort(), siteWide, rendersContent, writesText };
}

/** Array members that hand entries on (everything else is metadata: `length`, `includes`, …). */
const ENTRY_READS = new Set([
  "map",
  "flatMap",
  "forEach",
  "reduce",
  "join",
  "filter",
  "slice",
  "concat",
  "sort",
  "reverse",
  "at",
  "find",
  "values",
  "entries",
  "toString",
]);

/** Array methods whose callback runs per entry. */
const ITERATE_CALLS = new Set(["forEach", "map", "flatMap", "reduce"]);

/**
 * What a script renders into the page: array literals, the declarations
 * of the variables it reads (resolved lexically, so another function's
 * `items` is a different array), and property names (`config.items`).
 */
class Rendered {
  readonly nodes = new Set<Node>();
  /** Array literals bound to a variable the script renders. */
  readonly decls = new Set<Node>();
  readonly names = new Set<string>();

  constructor(private readonly scopes: JsScopes) {}

  /** One reference: `items`, `config.items` or an inline array literal. */
  add(ref: unknown): void {
    if (!isNode(ref)) return;
    if (ref.type === "ArrayExpression") this.nodes.add(ref);
    else if (ref.type === "Identifier") {
      const decl = this.scopes.resolve(ref);
      if (decl?.type === "VariableDeclarator" && isNode(decl.init)) this.decls.add(decl.init);
    } else {
      const name = memberName(ref);
      if (name !== null) this.names.add(name);
    }
  }

  /**
   * Every reference inside an expression written to the page, except a
   * read of its metadata: `events.length` or `events.includes(x)` puts no
   * entry into the page, `events[i]` and `events.map(…)` do.
   */
  addSubtree(root: unknown): void {
    const metadataOnly = new Set<Node>();
    for (const n of nodes(root)) {
      const prop = memberName(n);
      if (prop !== null && !ENTRY_READS.has(prop) && isNode(n.object)) metadataOnly.add(n.object);
    }
    for (const n of nodes(root)) if (!metadataOnly.has(n)) this.add(n);
  }
}

/** `const items = [ … ]` / `{ items: [ … ] }` → the name and the array literal. */
function bindingOfArray(n: Node): { name: string; array: Node; viaProperty: boolean } | null {
  if (n.type === "VariableDeclarator" && isNode(n.init) && n.init.type === "ArrayExpression") {
    const id = n.id;
    return isNode(id) && id.type === "Identifier"
      ? { name: id.name as string, array: n.init, viaProperty: false }
      : null;
  }
  if (n.type === "Property" && isNode(n.value) && n.value.type === "ArrayExpression") {
    const key = n.key;
    const name = isNode(key)
      ? key.type === "Identifier"
        ? (key.name as string)
        : stringLiteral(key)
      : null;
    return name !== null ? { name, array: n.value, viaProperty: true } : null;
  }
  return null;
}

/** Does a subtree write to the page (a markup / text sink or a DOM insert)? */
function containsSink(root: unknown, scopes: JsScopes): boolean {
  for (const n of nodes(root)) {
    if (n.type === "AssignmentExpression") {
      const prop = memberName(n.left);
      if (prop !== null && (MARKUP_SINK_PROPS.has(prop) || TEXT_SINK_PROPS.has(prop))) return true;
    }
    if (n.type === "CallExpression") {
      const name = memberName(n.callee);
      if (name === null) continue;
      if (TEXT_SINK_CALLS.has(name) && isDataReceiver(n.callee, scopes)) continue;
      if (DOM_INSERT_CALLS.has(name) || name === "createTextNode") return true;
    }
  }
  return false;
}

/** Request data that shares DOM method names (`append`), never the page. */
const DATA_CONSTRUCTORS = new Set(["FormData", "URLSearchParams", "Headers"]);

/**
 * Is the receiver of `x.append(…)` request data rather than a DOM node:
 * `new FormData()` inline or bound to the name, or a `searchParams`?
 */
function isDataReceiver(callee: unknown, scopes: JsScopes): boolean {
  if (!isNode(callee) || callee.type !== "MemberExpression") return false;
  let obj = callee.object;
  if (memberName(obj) === "searchParams") return true;
  if (isNode(obj) && obj.type === "Identifier") {
    const decl = scopes.resolve(obj);
    obj = decl?.type === "VariableDeclarator" ? decl.init : undefined;
  }
  return (
    isNode(obj) &&
    obj.type === "NewExpression" &&
    isNode(obj.callee) &&
    obj.callee.type === "Identifier" &&
    DATA_CONSTRUCTORS.has(obj.callee.name as string)
  );
}

function isDocument(callee: unknown): boolean {
  return (
    isNode(callee) &&
    callee.type === "MemberExpression" &&
    isNode(callee.object) &&
    callee.object.type === "Identifier" &&
    callee.object.name === "document"
  );
}

function noteMarkup(sink: string, text: string, out: string[], writesText: string[]): void {
  // Plain text through a markup sink is still text in the page.
  if (!/<[a-z]/i.test(text)) {
    noteText(text, writesText, out);
    return;
  }
  const why = markupContent(text);
  if (why === null) return;
  const what = why === "links" ? "links" : why === "text" ? "text" : "interpolated data";
  out.push(`writes markup with ${what} into ${sink} ("${excerpt(text)}")`);
}

function noteText(text: string, writesText: string[], rendersContent: string[]): void {
  if (markupContent(text) !== null) {
    rendersContent.push(`writes markup as text ("${excerpt(text)}")`);
    return;
  }
  const visible = text
    .replace(/\uE000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (visible.match(/\p{L}+/gu) ?? []).length;
  if (words >= MIN_TEXT_WORDS || visible.length >= MIN_TEXT_CHARS) {
    writesText.push(`"${excerpt(visible)}"`);
  }
}
