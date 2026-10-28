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
 * check verifies the claim (foreignHooks): a site-wide script may use
 * shared hooks only (rendered by three or more modules), never the hooks
 * of one or two modules.
 */

import { stripMustache } from "@caelo-cms/shared";
import { parseSync } from "oxc-parser";

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

/** A loosely typed ESTree node as oxc-parser returns it. */
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/** Every node of a subtree, depth first. */
function* nodes(root: unknown): Generator<Node> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (isNode(v)) {
      yield v;
      for (const [key, child] of Object.entries(v)) {
        if (key !== "type" && typeof child === "object" && child !== null) stack.push(child);
      }
    }
  }
}

/** The non-computed property name of a member expression, or null. */
function memberName(n: unknown): string | null {
  if (!isNode(n) || n.type !== "MemberExpression" || n.computed === true) return null;
  const p = n.property;
  return isNode(p) && p.type === "Identifier" ? (p.name as string) : null;
}

function stringLiteral(n: unknown): string | null {
  return isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : null;
}

/**
 * The static text of an expression, with `\uE000` where a value is
 * interpolated: literals, template parts, `+` chains, both branches of a
 * conditional, and template literals returned from callbacks
 * (`items.map((i) => \`<li>${i.label}</li>\`).join("")`).
 */
function staticText(expr: unknown): string {
  const parts: string[] = [];
  for (const n of nodes(expr)) {
    if (n.type === "TemplateLiteral") {
      const quasis = n.quasis as { value: { cooked: string | null } }[];
      parts.push(quasis.map((q) => q.value.cooked ?? "").join("\uE000"));
    } else {
      const s = stringLiteral(n);
      if (s !== null) parts.push(s);
    }
  }
  // Pieces of one expression are concatenated at runtime; a value between
  // them (`a + x + b`) is interpolated data.
  return parts.join("\uE000");
}

/**
 * The texts an expression can write: each branch of a conditional on its
 * own (`open ? "Menü schließen" : "Menü öffnen"` is two short labels, not
 * one long text).
 */
function variants(expr: unknown): string[] {
  if (isNode(expr) && expr.type === "ConditionalExpression") {
    return [...variants(expr.consequent), ...variants(expr.alternate)];
  }
  if (isNode(expr) && expr.type === "LogicalExpression") {
    return [...variants(expr.left), ...variants(expr.right)];
  }
  return [staticText(expr)];
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
  if (/\bhref\s*=/i.test(text)) return "links";
  // One word is a control label (`<span>Close</span>`); two are copy.
  if (wordCount(textOutsideTags(text)) >= 2) return "text";
  // `<li>${item.label}</li>`: the tag wraps an interpolated value.
  if (CONTENT_TAG_RE.test(text) && /\uE000/.test(stripTags(text))) return "data";
  return null;
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
  // Attribute values are not hooks (`[href="#top"]` names no id).
  const bare = selector.replace(/"[^"]*"|'[^']*'/g, '""');
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
  const bindings = new Map<string, Node[]>();
  const rendered = new Rendered();

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
        for (const t of variants(markupArg)) noteMarkup(`${name}()`, t, rendersContent);
      }
      if ((name !== null && TEXT_SINK_CALLS.has(name)) || name === "createTextNode") {
        rendered.addSubtree(args);
        for (const a of args) for (const t of variants(a)) noteText(t, writesText, rendersContent);
      }
      // `items.forEach((i) => { …appendChild… })`: the iterated array is rendered.
      if (name !== null && ITERATE_CALLS.has(name) && args.some(containsSink)) {
        rendered.add((n.callee as Node).object);
      }
    }

    if (n.type === "AssignmentExpression") {
      const prop = memberName(n.left);
      if (prop !== null && MARKUP_SINK_PROPS.has(prop)) {
        rendered.addSubtree(n.right);
        for (const t of variants(n.right)) noteMarkup(prop, t, rendersContent);
      } else if (prop !== null && TEXT_SINK_PROPS.has(prop)) {
        rendered.addSubtree(n.right);
        for (const t of variants(n.right)) noteText(t, writesText, rendersContent);
      }
    }

    // `for (const i of items) …` / `for (…; i < items.length; …) items[i]` with a sink inside.
    if (n.type === "ForOfStatement" && containsSink(n.body)) rendered.add(n.right);
    if ((n.type === "ForStatement" || n.type === "WhileStatement") && containsSink(n.body)) {
      for (const m of nodes(n.body)) {
        if (m.type === "MemberExpression" && m.computed === true) rendered.add(m.object);
      }
    }

    if (n.type === "ArrayExpression") {
      const a = contentArray(n);
      if (a) arrays.set(n, a);
    }
    const bound = bindingOfArray(n);
    if (bound) bindings.set(bound.name, [...(bindings.get(bound.name) ?? []), bound.array]);
  }

  // Data in an array is rendered content only when the script puts its
  // entries into the page; an array of analytics labels next to an
  // unrelated `textContent` write is not.
  for (const [node, a] of arrays) {
    const names = [...bindings].filter(([, list]) => list.includes(node)).map(([k]) => k);
    if (!rendered.nodes.has(node) && !names.some((k) => rendered.names.has(k))) continue;
    rendersContent.push(
      `renders ${a.count} entries from a JS array (${a.sample.map((x) => `"${x}"`).join(", ")}, …)`,
    );
  }

  return { hooks: [...hooks].sort(), siteWide, rendersContent, writesText };
}

/** Array methods whose callback runs per entry. */
const ITERATE_CALLS = new Set(["forEach", "map", "flatMap", "reduce"]);

/** What a script renders into the page: array literals and the names they are reached by. */
class Rendered {
  readonly nodes = new Set<Node>();
  readonly names = new Set<string>();

  /** One reference: `items`, `config.items` or an inline array literal. */
  add(ref: unknown): void {
    if (!isNode(ref)) return;
    if (ref.type === "ArrayExpression") this.nodes.add(ref);
    else if (ref.type === "Identifier") this.names.add(ref.name as string);
    else {
      const name = memberName(ref);
      if (name !== null) this.names.add(name);
    }
  }

  /** Every reference inside an expression written to the page. */
  addSubtree(root: unknown): void {
    for (const n of nodes(root)) this.add(n);
  }
}

/** `const items = [ … ]` / `{ items: [ … ] }` → the name and the array literal. */
function bindingOfArray(n: Node): { name: string; array: Node } | null {
  if (n.type === "VariableDeclarator" && isNode(n.init) && n.init.type === "ArrayExpression") {
    const id = n.id;
    return isNode(id) && id.type === "Identifier"
      ? { name: id.name as string, array: n.init }
      : null;
  }
  if (n.type === "Property" && isNode(n.value) && n.value.type === "ArrayExpression") {
    const key = n.key;
    const name = isNode(key)
      ? key.type === "Identifier"
        ? (key.name as string)
        : stringLiteral(key)
      : null;
    return name !== null ? { name, array: n.value } : null;
  }
  return null;
}

/** Does a subtree write to the page (a markup / text sink or a DOM insert)? */
function containsSink(root: unknown): boolean {
  for (const n of nodes(root)) {
    if (n.type === "AssignmentExpression") {
      const prop = memberName(n.left);
      if (prop !== null && (MARKUP_SINK_PROPS.has(prop) || TEXT_SINK_PROPS.has(prop))) return true;
    }
    if (n.type === "CallExpression") {
      const name = memberName(n.callee);
      if (name !== null && (DOM_INSERT_CALLS.has(name) || name === "createTextNode")) return true;
    }
  }
  return false;
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

function noteMarkup(sink: string, text: string, out: string[]): void {
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

/** The hooks a template renders: its classes, ids and `data-*` attribute names. */
export function templateHooks(html: string): Set<string> {
  const markup = stripMustache(html);
  const out = new Set<string>();
  for (const m of markup.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const c of (m[1] ?? m[2] ?? "").split(/\s+/)) if (c) out.add(`.${c}`);
  }
  for (const m of markup.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v) out.add(`#${v}`);
  }
  for (const m of markup.matchAll(/\s(data-[\w-]+)/gi))
    out.add(`[${(m[1] as string).toLowerCase()}]`);
  return out;
}

/** Platform hooks every module may use (the interaction kit, composer stamps). */
function isPlatformHook(hook: string): boolean {
  return hook.startsWith("[data-caelo-") || hook.startsWith(".caelo-");
}

/**
 * A hook three or more modules render is shared by design (`[data-reveal]`
 * on every section); one that one or two modules render is theirs — two,
 * because a pattern kept as two module copies (the demo form) is still
 * one component.
 */
const SHARED_HOOK_OWNERS = 3;

/** How a module's JS relates to the hooks other modules render. */
export interface ForeignHooks {
  /** Other module id → hooks of that module's own markup the JS drives. */
  readonly specific: ReadonlyMap<string, readonly string[]>;
  /** Shared hooks (rendered by three or more modules) the JS drives without a site-wide declaration. */
  readonly shared: readonly string[];
}

/**
 * The hooks a module's JS takes from other modules.
 *
 * @param own - the module itself plus every module nested inside it.
 * @param owners - hook → ids of the modules whose templates render it.
 * @param neutral - hooks of the layout chrome, which any module may drive.
 */
export function foreignHooks(
  facts: ModuleJsFacts,
  own: ReadonlySet<string>,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
  neutral: ReadonlySet<string> = new Set(),
): ForeignHooks {
  const specific = new Map<string, string[]>();
  const shared: string[] = [];
  for (const hook of facts.hooks) {
    if (isPlatformHook(hook) || neutral.has(hook)) continue;
    const by = owners.get(hook);
    if (!by || by.size === 0 || [...by].some((id) => own.has(id))) continue;
    if (by.size >= SHARED_HOOK_OWNERS) {
      if (facts.siteWide === null || facts.siteWide.length === 0) shared.push(hook);
      continue;
    }
    for (const id of by) specific.set(id, [...(specific.get(id) ?? []), hook]);
  }
  return { specific, shared };
}

/** hook → ids of the modules whose templates render it. */
export function hookOwners(
  modules: readonly { readonly id: string; readonly html: string }[],
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const m of modules) {
    for (const h of templateHooks(m.html)) {
      const set = owners.get(h) ?? new Set<string>();
      set.add(m.id);
      owners.set(h, set);
    }
  }
  return owners;
}
