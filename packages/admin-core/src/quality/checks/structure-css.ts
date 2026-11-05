// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1371 — CSS where it is used, in the core `structure` check.
 *
 * Module CSS already ships only on the pages that place the module
 * (preview-compose: one copy per module). What ships without serving the
 * page is the layout's CSS (every page of the layout), CSS for classes
 * nothing renders, and one declaration block re-described in several
 * modules:
 *
 * - `structure/unused-css` (warning): layout or placed-module CSS for
 *   classes no staged page renders. A class still counts as used when the
 *   stylesheet owner's template CAN render it (an optional variant class,
 *   `{{#dark}}is-dark{{/dark}}`), a module script adds, selects or writes
 *   it ({@link scriptClassNames}) or it fits a class a template or script
 *   builds from a value (`s{{group}}`, {@link fitsBuiltClass}). Platform
 *   classes (`caelo-*`) never count.
 * - `structure/page-specific-layout-css` (warning): layout CSS for classes
 *   several modules use but that appear on fewer than
 *   {@link PAGE_SPECIFIC_SHARE} of the layout's pages — product-page rules
 *   every blog post downloads. Classes one module alone uses are
 *   `layout-css-module-specific`'s; this rule does not repeat them.
 * - `structure/duplicate-css` (warning): the same declaration block (at
 *   least {@link MIN_DUPLICATE_DECLARATIONS} declarations, same at-rule
 *   context) in the CSS of {@link MIN_DUPLICATE_MODULES}+ placed modules.
 *
 * Class extraction is the structure check's own (`selectorClasses`); the
 * rule splitter below reads style rules at the top level and inside
 * grouping at-rules and skips everything else (`@keyframes`, `@font-face`).
 */

import {
  PLACEHOLDER_MARK,
  parseMarkup,
  stripMustache,
  truncateKeepingIds,
} from "@caelo-cms/shared";
import { parseSync } from "oxc-parser";
import type { Finding } from "./findings.js";
import { analyseModuleJs } from "./module-js-analysis.js";
import { isNode, JsScopes, type Node, nodes } from "./module-js-ast.js";
import type { ClassUse, StructureModule } from "./structure-analysis.js";
import { selectorClasses } from "./structure-analysis.js";

/** Share of a layout's pages below which a layout class is page-specific. */
export const PAGE_SPECIFIC_SHARE = 0.5;
/** Fewest pages of a layout before a share means anything. */
export const PAGE_SPECIFIC_MIN_PAGES = 6;
/** Declarations a block needs before a repeat of it is a duplicate. */
export const MIN_DUPLICATE_DECLARATIONS = 3;
/** Modules that must carry one block before it is reported. */
export const MIN_DUPLICATE_MODULES = 3;
/** Most classes / modules a message names. */
const MAX_LISTED = 8;

/** A layout as the CSS rules need it. */
export interface CssLayout {
  readonly id: string;
  readonly displayName: string;
  readonly html: string;
  readonly css: string;
}

/** What the staged pages render, folded per page by the caller (structure.ts). */
export interface RenderedClasses {
  /** Every class any staged page renders. */
  readonly all: ReadonlySet<string>;
  /** Layout id → how many staged pages use it. */
  readonly layoutPages: ReadonlyMap<string, number>;
  /** Layout id → class of its CSS → page type id → pages of the layout carrying the class. */
  readonly layoutClassPages: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>;
}

/**
 * Folds the per-page class sets of `measurePage` (structure-weight-analysis.ts) into
 * {@link RenderedClasses}. `pageLayouts` maps page id → layout id;
 * `pageTypes` page id → page type id.
 */
export function createRenderedFold(
  layouts: readonly CssLayout[],
  pageLayouts: ReadonlyMap<string, string>,
  pageTypes: ReadonlyMap<string, string>,
): { add(pageId: string, classes: ReadonlySet<string>): void; result(): RenderedClasses } {
  const all = new Set<string>();
  const layoutPages = new Map<string, number>();
  const layoutClasses = new Map(layouts.map((l) => [l.id, selectorClasses(l.css)]));
  const layoutClassPages = new Map<string, Map<string, Map<string, number>>>();
  return {
    add(pageId, classes) {
      for (const c of classes) all.add(c);
      const layoutId = pageLayouts.get(pageId);
      const own = layoutId === undefined ? undefined : layoutClasses.get(layoutId);
      if (layoutId === undefined || own === undefined) return;
      layoutPages.set(layoutId, (layoutPages.get(layoutId) ?? 0) + 1);
      const perClass = layoutClassPages.get(layoutId) ?? new Map<string, Map<string, number>>();
      layoutClassPages.set(layoutId, perClass);
      const type = pageTypes.get(pageId) ?? "";
      for (const c of own) {
        if (!classes.has(c)) continue;
        const byType = perClass.get(c) ?? new Map<string, number>();
        byType.set(type, (byType.get(type) ?? 0) + 1);
        perClass.set(c, byType);
      }
    },
    result: () => ({ all, layoutPages, layoutClassPages }),
  };
}

/**
 * Every class a template can render, optional section classes included.
 * A class built from a field keeps {@link PLACEHOLDER_MARK} where the value
 * goes (`s{{group}}` → `s\u001f`).
 */
export function templateClasses(html: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: { classes: readonly string[]; children: readonly unknown[] }) => {
    for (const c of n.classes) out.add(c);
    for (const c of n.children) walk(c as typeof n);
  };
  const markup = stripMustache(html, {
    keepOptionalAttributeText: true,
    markTagPlaceholders: true,
  });
  for (const r of parseMarkup(markup)) walk(r);
  return out;
}

/**
 * Can `built`, a class holding {@link PLACEHOLDER_MARK}, render as `cls`?
 * All text around the values must match in order, and each value must
 * start and end at a boundary: `s{{group}}` renders `s0`, `card--{{tone}}`
 * renders `card--dark`, but no value of `s{{group}}` is meant to spell
 * `sidebar`. A class with no fixed start or end could be any class, so it
 * proves nothing: counting it would hide every dead rule of a module with
 * one such class.
 */
export function fitsBuiltClass(built: string, cls: string): boolean {
  const parts = built.split(PLACEHOLDER_MARK);
  const head = parts[0] ?? "";
  const tail = parts[parts.length - 1] ?? "";
  if (head === "" && tail === "") return false;
  if (cls.length < head.length + tail.length) return false;
  if (!cls.startsWith(head) || !cls.endsWith(tail)) return false;
  const midWord = (a: string, b: string) => /[a-z]$/.test(a) && /^[a-z]/.test(b);
  const end = cls.length - tail.length;
  let at = head.length;
  let before = head;
  for (const text of parts.slice(1, -1)) {
    if (text === "") continue;
    const found = cls.indexOf(text, at);
    if (found < 0 || found + text.length > end) return false;
    const value = cls.slice(at, found);
    if (midWord(before, value) || midWord(value, text)) return false;
    at = found + text.length;
    before = text;
  }
  const value = cls.slice(at, end);
  return !midWord(before, value) && !midWord(value, tail);
}

/** Class-list methods whose string arguments are class names. */
const CLASS_LIST_METHODS = new Set(["add", "remove", "toggle", "replace", "contains"]);

/**
 * The class names module scripts reference, so a class a script adds,
 * selects or writes is not reported as unused: classes in selector strings
 * (the module-JS analysis' hooks, `getElementsByClassName` included), the
 * arguments of `classList.add/remove/toggle/replace/contains`, what is
 * assigned to `className`, the value of `setAttribute("class", …)` and the
 * `class` attributes of markup in strings (`innerHTML`, a function that
 * returns an SVG). What counts is the text the expression can evaluate to
 * ({@link staticText}): literals, either branch of a conditional, a
 * concatenation, a constant. A part only known at runtime stays a hole
 * ({@link PLACEHOLDER_MARK}), so `'st-' + n` is a built class (see
 * {@link fitsBuiltClass}) and a name wholly assembled at runtime stays
 * unknown. A string that merely spells a class elsewhere counts for
 * nothing: an unrelated identifier must not hide dead CSS.
 */
export function scriptClassNames(scripts: readonly string[]): Set<string> {
  const out = new Set<string>();
  const addWords = (text: string) => {
    for (const w of text.split(/\s+/)) {
      if (CLASS_WORD.test(w.replaceAll(PLACEHOLDER_MARK, "x"))) out.add(w);
    }
  };
  for (const js of scripts) {
    if (js.trim().length === 0) continue;
    for (const hook of analyseModuleJs(js).hooks) if (hook.startsWith(".")) out.add(hook.slice(1));
    const parsed = parseSync("module.js", js, { sourceType: "script" });
    if (parsed.errors.some((e) => e.severity === "Error")) continue;
    const scopes = new JsScopes(parsed.program as unknown as Node);
    const inner = new Set<Node>();
    const text = (v: unknown) => staticText(v, scopes);
    for (const n of nodes(parsed.program)) {
      if (STRING_NODES.has(n.type) && !inner.has(n)) {
        // The whole concatenation at once, so an attribute split by an
        // expression (`'<b class="a ' + x + ' c">'`) reads as one.
        const whole = staticText(n, scopes, inner);
        for (const m of whole.matchAll(CLASS_ATTRIBUTE)) addWords(m[1] ?? m[2] ?? "");
      }
      if (n.type === "CallExpression") {
        const callee = n.callee as Node;
        const args = n.arguments as unknown[];
        const method = propertyName(callee);
        if (
          method !== null &&
          CLASS_LIST_METHODS.has(method) &&
          propertyName(callee.object) === "classList"
        )
          for (const a of args) addWords(text(a));
        if (method === "setAttribute" && literalText(args[0]) === "class") addWords(text(args[1]));
      }
      if (n.type === "AssignmentExpression" && propertyName(n.left) === "className")
        addWords(text(n.right));
    }
  }
  return out;
}

/** A class token; a hole of {@link staticText} is read as one more word character. */
const CLASS_WORD = /^-?[_a-zA-Z][\w-]*$/;
/**
 * A `class` attribute in markup text, not the end of another attribute's
 * name (`data-class`) or text inside its value. Its closing quote may be
 * past the end of the string.
 */
const CLASS_ATTRIBUTE = /(?:^|\s)class\s*=\s*(?:"([^"]*)|'([^']*))/gi;
/** Expressions that can hold markup text. */
const STRING_NODES = new Set(["Literal", "TemplateLiteral", "BinaryExpression"]);
/**
 * What one {@link staticText} call may read. Variables make the expression
 * a graph (`var b = a + a, c = b + b, …`), and module JS is untrusted input
 * to the audit: without a bound that doubling hangs it. Past the bound a
 * part reads as a hole, the same as a part only known at runtime.
 */
const MAX_TEXT_NODES = 4096;
const MAX_TEXT_CHARS = 1 << 20;

/**
 * The text an expression can evaluate to, with {@link PLACEHOLDER_MARK}
 * for each part only known at runtime. Both branches of a conditional are
 * set apart by spaces, each a word of its own in a class list, and the
 * conditional itself stays a hole for the text glued to it
 * (`'card--' + (dark ? 'dark' : 'light')` builds `card--…`). A variable
 * reads as its initial value. `visited` collects
 * the nodes read, which the caller need not read on their own.
 */
function staticText(root: unknown, scopes: JsScopes, visited = new Set<Node>()): string {
  const resolving = new Set<Node>();
  let nodesLeft = MAX_TEXT_NODES;
  let charsLeft = MAX_TEXT_CHARS;
  const take = (text: string): string => {
    if (text.length > charsLeft) return PLACEHOLDER_MARK;
    charsLeft -= text.length;
    return text;
  };
  const read = (v: unknown): string => {
    if (!isNode(v) || nodesLeft <= 0) return PLACEHOLDER_MARK;
    nodesLeft--;
    visited.add(v);
    switch (v.type) {
      case "Literal":
        return typeof v.value === "string" ? take(v.value) : PLACEHOLDER_MARK;
      case "TemplateLiteral": {
        const quasis = v.quasis as { value: { cooked: string | null } }[];
        const expressions = v.expressions as unknown[];
        return quasis
          .map(
            (q, i) =>
              take(q.value.cooked ?? "") + (i < expressions.length ? read(expressions[i]) : ""),
          )
          .join("");
      }
      case "BinaryExpression":
        return v.operator === "+" ? read(v.left) + read(v.right) : PLACEHOLDER_MARK;
      case "ConditionalExpression":
        return `${PLACEHOLDER_MARK} ${read(v.consequent)} ${read(v.alternate)} ${PLACEHOLDER_MARK}`;
      case "LogicalExpression":
        return `${PLACEHOLDER_MARK} ${read(v.left)} ${read(v.right)} ${PLACEHOLDER_MARK}`;
      case "ParenthesizedExpression":
        return read(v.expression);
      case "Identifier": {
        const decl = scopes.resolve(v);
        if (decl?.type !== "VariableDeclarator" || resolving.has(decl)) return PLACEHOLDER_MARK;
        resolving.add(decl);
        const text = read(decl.init);
        resolving.delete(decl);
        return text;
      }
      default:
        return PLACEHOLDER_MARK;
    }
  };
  return read(root);
}

/** `x.name` / `x["name"]` → name; null for anything else. */
function propertyName(v: unknown): string | null {
  if (!isNode(v) || v.type !== "MemberExpression") return null;
  const p = v.property as Node;
  if (!v.computed && p.type === "Identifier") return p.name as string;
  return literalText(p);
}

/** A string literal's value or a template literal's static text (no expressions); null otherwise. */
function literalText(v: unknown): string | null {
  if (!isNode(v)) return null;
  if (v.type === "Literal" && typeof v.value === "string") return v.value;
  if (v.type === "TemplateLiteral" && (v.expressions as unknown[]).length === 0)
    return (v.quasis as { value: { cooked: string | null } }[])
      .map((q) => q.value.cooked ?? "")
      .join("");
  return null;
}

/** `structure/unused-css` findings: one per stylesheet owner with dead classes. */
export function unusedCssFindings(
  layouts: readonly CssLayout[],
  placedModules: readonly StructureModule[],
  rendered: RenderedClasses,
  scripts: ReadonlySet<string>,
): Finding[] {
  const owners = [...layouts, ...placedModules];
  // Across owners, as for rendered classes: layout CSS styles what modules render.
  const built = [
    ...new Set([...owners.flatMap((o) => [...templateClasses(o.html)]), ...scripts]),
  ].filter((c) => c.includes(PLACEHOLDER_MARK));
  const dead = (css: string, own: ReadonlySet<string>) =>
    [...selectorClasses(css)].filter(
      (c) =>
        !c.startsWith("caelo-") &&
        !rendered.all.has(c) &&
        !own.has(c) &&
        !scripts.has(c) &&
        !built.some((b) => fitsBuiltClass(b, c)),
    );
  const findings: Finding[] = [];
  for (const l of layouts) {
    const classes = dead(l.css, templateClasses(l.html));
    if (classes.length === 0) continue;
    findings.push(
      unusedFinding(`layout "${l.displayName}" (${l.id})`, classes, {
        tool: "propose_update_layout",
        hint: "remove the rules for these classes from the layout css (they ship on every page and style nothing); if one belongs to a module you are about to place, move it into that module's css instead",
      }),
    );
  }
  for (const m of placedModules) {
    const classes = dead(m.css, templateClasses(m.html));
    if (classes.length === 0) continue;
    findings.push(
      unusedFinding(`module "${m.displayName}" (${m.id})`, classes, {
        tool: "update_modules_many",
        hint: "remove the rules for these classes from the module css: neither its html nor any staged page renders them",
      }),
    );
  }
  return findings;
}

function unusedFinding(
  owner: string,
  classes: readonly string[],
  fix: { tool: string; hint: string },
): Finding {
  return {
    ruleId: "structure/unused-css",
    severity: "warning",
    message: clip(
      `Unused CSS: ${owner} styles ${list(classes.map((c) => `.${c}`))} — no staged page renders these classes and no script names them, yet every page that loads this CSS downloads and matches them.`,
    ),
    fix,
  };
}

/** `structure/page-specific-layout-css` findings: one per layout. */
export function pageSpecificLayoutCssFindings(
  layouts: readonly CssLayout[],
  rendered: RenderedClasses,
  classUse: ReadonlyMap<string, ClassUse>,
  pageTypeNames: ReadonlyMap<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const l of layouts) {
    const pages = rendered.layoutPages.get(l.id) ?? 0;
    if (pages < PAGE_SPECIFIC_MIN_PAGES) continue;
    const own = templateClasses(l.html);
    const perClass = rendered.layoutClassPages.get(l.id) ?? new Map();
    const specific: string[] = [];
    for (const cls of selectorClasses(l.css)) {
      const use = classUse.get(cls);
      // Unused (reported as such) or one module's / free markup's
      // (layout-css-module-specific) or the layout's own chrome: not here.
      if (!use || use.chrome || own.has(cls) || cls.startsWith("caelo-")) continue;
      if (use.modules.size <= 1) continue;
      const byType = perClass.get(cls) ?? new Map<string, number>();
      const on = [...byType.values()].reduce((a, b) => a + b, 0);
      if (on === 0 || on / pages >= PAGE_SPECIFIC_SHARE) continue;
      const types = [...byType]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => pageTypeNames.get(id) ?? id);
      specific.push(`.${cls} (${on} of ${pages} pages: ${types.slice(0, 3).join(", ")})`);
    }
    if (specific.length === 0) continue;
    findings.push({
      ruleId: "structure/page-specific-layout-css",
      severity: "warning",
      message: clip(
        `Page-specific CSS in the layout: layout "${l.displayName}" (${l.id}) styles ${list(specific)} — every page of the layout downloads these rules, but only a few pages render them.`,
      ),
      fix: {
        tool: "update_modules_many",
        hint: "move each rule into the css of the modules that render the class (each module's css ships only where it is placed), or into the template css of the page type those pages use (propose_update_template); then remove them from the layout with propose_update_layout",
      },
    });
  }
  return findings;
}

/** `structure/duplicate-css` findings: one per set of modules sharing blocks. */
export function duplicateCssFindings(placedModules: readonly StructureModule[]): Finding[] {
  const owners = new Map<string, { modules: Set<string>; selectors: Set<string> }>();
  for (const m of placedModules) {
    for (const r of cssRules(m.css)) {
      const decls = declarations(r.body);
      if (decls.length < MIN_DUPLICATE_DECLARATIONS) continue;
      const key = `${r.context}\u0000${decls.join(";")}`;
      const o = owners.get(key) ?? { modules: new Set(), selectors: new Set() };
      o.modules.add(m.id);
      o.selectors.add(r.selector);
      owners.set(key, o);
    }
  }
  const byModuleSet = new Map<string, { modules: string[]; blocks: number; selectors: string[] }>();
  for (const o of owners.values()) {
    if (o.modules.size < MIN_DUPLICATE_MODULES) continue;
    const modules = [...o.modules].sort();
    const key = modules.join("\u0000");
    const g = byModuleSet.get(key) ?? { modules, blocks: 0, selectors: [] };
    g.blocks++;
    g.selectors.push(...o.selectors);
    byModuleSet.set(key, g);
  }
  const byId = new Map(placedModules.map((m) => [m.id, m]));
  return [...byModuleSet.values()].map((g) => ({
    ruleId: "structure/duplicate-css",
    severity: "warning" as const,
    message: clip(
      `Duplicate CSS: modules ${list(g.modules.map((id) => `"${byId.get(id)?.displayName ?? id}" (${id})`))} each describe the same ${g.blocks} rule block(s) (${list([...new Set(g.selectors)])}) — one component styled ${g.modules.length} times, and the copies drift apart.`,
    ),
    fix: {
      tool: "update_modules_many",
      hint: "if these modules are one pattern, keep one module and place it everywhere (delete_modules_many for the copies); if they only share a component (a button, a card), keep its rules ONCE as a layout class used by every module's html (propose_update_layout) and drop the copies from the module css",
    },
  }));
}

/** One style rule: its at-rule context, selector and declaration block. */
interface CssRule {
  readonly context: string;
  readonly selector: string;
  readonly body: string;
}

const GROUPING_AT_RULES = /^@(media|supports|layer|container)\b/i;

/** Style rules of a stylesheet, at the top level and inside grouping at-rules. */
export function cssRules(css: string, context = ""): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text
      .slice(i, open)
      .replace(/^[\s;]+/, "")
      .trim();
    const close = matchingBrace(text, open);
    const body = text.slice(open + 1, close);
    if (prelude.startsWith("@")) {
      if (GROUPING_AT_RULES.test(prelude))
        out.push(...cssRules(body, `${context}${prelude.replace(/\s+/g, " ")}|`));
    } else if (prelude.length > 0) {
      out.push({ context, selector: prelude.replace(/\s+/g, " "), body });
    }
    i = close + 1;
  }
  return out;
}

/** Index of the `}` closing the block opened at `open` (strings skipped); end of text when unclosed. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, j + 1);
      j = end < 0 ? text.length : end;
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return text.length;
}

/** A block's declarations, normalised (property lower-cased, whitespace collapsed) and sorted. */
function declarations(body: string): string[] {
  return body
    .split(";")
    .map((d) => {
      const colon = d.indexOf(":");
      if (colon < 0) return "";
      const prop = d.slice(0, colon).trim().toLowerCase();
      const value = d
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " ");
      return prop.length > 0 && value.length > 0 ? `${prop}:${value}` : "";
    })
    .filter((d) => d.length > 0)
    .sort();
}

function list(items: readonly string[]): string {
  const head = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${head} … (+${items.length - MAX_LISTED})` : head;
}

function clip(message: string): string {
  return truncateKeepingIds(message, 1000);
}
