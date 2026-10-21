// SPDX-License-Identifier: MPL-2.0

/**
 * issue #158 — module CSS scoping check (epic #149).
 *
 * Every module's CSS lands in ONE page-wide stylesheet, so a selector
 * that is not tied to the module bleeds into every other module on the
 * page: an `h1 {}` in the hero restyles the pricing table's heading, a
 * `.card {}` in one module restyles another module's cards. The
 * convention (edit_module description, design-quality skill) is to nest
 * module CSS under the module's own root class; this scanner is the
 * mechanical write-time check that rides the authoring tool's result,
 * so the AI fixes the selector in the same turn. A warning, not a gate:
 * the write already succeeded, and a module may legitimately style
 * something global on purpose.
 *
 * Pure string analysis, no CSS parser dependency: comments and strings
 * are skipped, rule preludes are read at the top level and inside
 * grouping at-rules (`@media`, `@supports`, `@layer`, `@container`),
 * and blocks whose contents are not selectors (`@keyframes`,
 * `@font-face`, …) are skipped whole.
 */

/** Grouping at-rules whose blocks contain style rules. */
const GROUPING_AT_RULES = new Set(["media", "supports", "layer", "container", "document"]);

/** Max offending selectors named per finding. */
const MAX_SELECTORS_SHOWN = 5;

/** Index just past the string literal starting at `i` (a quote char). */
function skipString(css: string, i: number): number {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== quote) {
    if (css[j] === "\\") j++;
    j++;
  }
  return j + 1;
}

/** Index of the `}` matching the `{` at `open`, or css.length when unbalanced. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = skipString(css, i) - 1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/** Selector preludes of every style rule in `css[start, end)`, recursing into grouping at-rules. */
function collectPreludes(css: string, start: number, end: number, out: string[]): void {
  let i = start;
  while (i < end) {
    // Read one prelude: up to `{` (a block) or `;` (a statement at-rule).
    let j = i;
    while (j < end && css[j] !== "{" && css[j] !== ";" && css[j] !== "}") {
      if (css[j] === '"' || css[j] === "'") j = skipString(css, j);
      else j++;
    }
    const prelude = css.slice(i, j).trim();
    if (j >= end) return;
    if (css[j] !== "{") {
      i = j + 1;
      continue;
    }
    const close = matchingBrace(css, j);
    if (prelude.startsWith("@")) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
      if (GROUPING_AT_RULES.has(name)) collectPreludes(css, j + 1, close, out);
    } else if (prelude.length > 0) {
      out.push(prelude);
    }
    i = close + 1;
  }
}

/** Split a selector list on top-level commas (not inside `()` / `[]`). */
function splitSelectorList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(prelude.slice(from, i));
      from = i + 1;
    }
  }
  out.push(prelude.slice(from));
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s.length > 0);
}

/** The selector with every `(…)` argument removed (`:not(.x)` does not scope `h1:not(.x)`). */
function withoutArguments(selector: string): string {
  let out = "";
  let depth = 0;
  for (const c of selector) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

/**
 * Index of the first character after leading whitespace and `<!-- -->`
 * comments, or -1 when a comment is never closed. A scan, not a regex:
 * `(?:<!--[\s\S]*?-->\s*)*` backtracks exponentially on `<!----><!--…`
 * input (CodeQL js/redos), and module html is operator/AI supplied.
 */
function skipLeadingHtmlComments(html: string): number {
  let i = 0;
  for (;;) {
    while (i < html.length && /\s/.test(html.charAt(i))) i++;
    if (!html.startsWith("<!--", i)) return i;
    const end = html.indexOf("-->", i + 4);
    if (end === -1) return -1;
    i = end + 3;
  }
}

/**
 * The attribute text of the start tag at `at` (`""` for `<div>`), or null
 * when no element starts there. Parsed by hand: the regex form
 * `<name(\s[^>]*)?>` is quadratic on `<A\t<A\t…` input without a `>`
 * (CodeQL js/polynomial-redos).
 */
function openTagAttributes(html: string, at: number): string | null {
  if (html.charAt(at) !== "<" || !/[a-zA-Z]/.test(html.charAt(at + 1))) return null;
  let nameEnd = at + 2;
  while (nameEnd < html.length && /[\w-]/.test(html.charAt(nameEnd))) nameEnd++;
  const close = html.indexOf(">", nameEnd);
  if (close === -1) return null;
  const attrs = html.slice(nameEnd, close);
  return attrs === "" || /^\s/.test(attrs) ? attrs : null;
}

/** Class and id tokens of the module's first element, or null when the html has no element. */
export function moduleRootTokens(html: string): { classes: string[]; id: string | null } | null {
  const start = skipLeadingHtmlComments(html);
  if (start === -1) return null;
  const attrs = openTagAttributes(html, start);
  if (attrs === null) return null;
  const classAttr = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  const classes = (classAttr?.[1] ?? classAttr?.[2] ?? "")
    .split(/\s+/)
    .filter((c) => c.length > 0 && !c.includes("{{"));
  const idAttr = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  const id = idAttr?.[1] ?? idAttr?.[2] ?? null;
  return { classes, id: id !== null && !id.includes("{{") ? id : null };
}

/**
 * The CSS without its comments. An unterminated `/*` runs to the end of
 * the input, as in the CSS syntax spec. A scan rather than a lazy regex,
 * which is quadratic on `/*a/*a/*…` input (CodeQL js/polynomial-redos).
 */
function stripCssComments(css: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = css.indexOf("/*", from);
    if (open === -1) return out + css.slice(from);
    out += css.slice(from, open);
    const close = css.indexOf("*/", open + 2);
    if (close === -1) return out;
    from = close + 2;
  }
}

/** What the scope check found in one module's CSS. */
export interface CssScopeFindings {
  /** Selectors with no class, id or attribute at all (`h1`, `body p`, `*`). */
  readonly global: string[];
  /** Selectors that are not tied to the module's root class (needs the html). */
  readonly unanchored: string[];
  /** The module's root classes the CSS was checked against. */
  readonly rootClasses: string[];
  /** The module has CSS but its root element carries no class to scope under. */
  readonly rootHasNoClass: boolean;
}

/**
 * Check a module's CSS for selectors that bleed into other modules.
 * Pass the module's `html` when the write carried it: the selectors are
 * then also checked against the root element's classes. Prefixed class
 * names count as scoped (`.hero__title`, `.hero-cta` under root `.hero`).
 */
export function scanModuleCssScope(input: { css: string; html?: string }): CssScopeFindings {
  const css = stripCssComments(input.css);
  const preludes: string[] = [];
  collectPreludes(css, 0, css.length, preludes);
  const selectors = preludes.flatMap(splitSelectorList);

  const root = input.html !== undefined ? moduleRootTokens(input.html) : null;
  const rootClasses = root?.classes ?? [];
  const anchorable = rootClasses.length > 0 || (root?.id ?? null) !== null;

  const global: string[] = [];
  const unanchored: string[] = [];
  for (const selector of selectors) {
    const bare = withoutArguments(selector);
    if (!/[.#[]/.test(bare)) {
      global.push(selector);
      continue;
    }
    if (!anchorable) continue;
    const classes = [...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? "");
    const anchored =
      classes.some((c) =>
        rootClasses.some((r) => c === r || c.startsWith(`${r}-`) || c.startsWith(`${r}_`)),
      ) ||
      (root?.id != null && bare.includes(`#${root.id}`));
    if (!anchored) unanchored.push(selector);
  }
  return {
    global,
    unanchored,
    rootClasses,
    rootHasNoClass: root !== null && !anchorable && selectors.length > 0,
  };
}

function listSelectors(selectors: readonly string[]): string {
  const shown = selectors.slice(0, MAX_SELECTORS_SHOWN).map((s) => `\`${s}\``);
  const more = selectors.length - shown.length;
  return more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ");
}

/** The findings as one tool-result sentence group, or null when the CSS is scoped. */
export function formatCssScopeFindings(f: CssScopeFindings): string | null {
  const scopeHint =
    f.rootClasses.length > 0
      ? `nest them under the module root \`.${f.rootClasses[0]}\` (e.g. \`.${f.rootClasses[0]} h2\`)`
      : "nest them under the module's root class";
  const parts: string[] = [];
  if (f.global.length > 0) {
    parts.push(
      `module CSS selectors ${listSelectors(f.global)} style EVERY matching element on the page, including other modules' — ${scopeHint}`,
    );
  }
  if (f.unanchored.length > 0) {
    parts.push(
      `module CSS selectors ${listSelectors(f.unanchored)} are not scoped to this module and can restyle other modules using the same class — ${scopeHint} or prefix the class with it`,
    );
  }
  if (f.rootHasNoClass) {
    parts.push(
      'the module\'s root element has no class to scope its CSS under — give it one (e.g. `<section class="pricing">`) and nest the module CSS under it',
    );
  }
  return parts.length > 0 ? parts.join(". ") : null;
}
