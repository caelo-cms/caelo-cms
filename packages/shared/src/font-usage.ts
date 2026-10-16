// SPDX-License-Identifier: MPL-2.0

/**
 * Which font weights a site can render — the input to the default `wght`
 * clamp of pinned faces (see `font-axis-policy.ts`).
 *
 * Clamping `wght` is only safe when the result is a superset of every
 * computed `font-weight` any element can end up with. A weight outside
 * the delivered range does not fail visibly: the browser silently
 * renders the nearest end of the range (800 → 700). So this module is
 * deliberately conservative, and when it cannot be CERTAIN it reports
 * `weights: null`, which keeps the full axis. Full is the safe outcome,
 * not a degraded one — it is exactly what shipped before clamping.
 *
 * How the set is built:
 *
 *  - It is site-wide, not per family. `font-weight` inherits separately
 *    from `font-family`, so a weight declared under another family still
 *    reaches a pinned face through inheritance. Treating every declared
 *    weight as applicable to every family over-approximates; it never
 *    under-approximates.
 *  - 400 (the initial value) and 700 (UA `bold` on h1-h6, th, ...) are
 *    always in. UA `b, strong { font-weight: bolder }` applies wherever
 *    rich text puts a `<strong>`, so the set is always closed under
 *    `bolder` (400 → 700 → 900); under `lighter` too when any source uses
 *    it. CSS Fonts 4 maps both deterministically from the parent weight,
 *    and every parent weight is itself in the set, so the closure is
 *    complete rather than a guess.
 *  - Every `font-weight` declaration (CSS, `style=""`, JSON-escaped
 *    content, script text), every `font:` shorthand and every camel-case
 *    `fontWeight` assignment is parsed. `var(--x)` is resolved against
 *    every declaration of `--x` in any source plus its fallback; a
 *    custom property that is also touched any other way (`setProperty`,
 *    `@property`) is not knowable and makes the result uncertain.
 *  - Anything else that could set a weight — `calc()`, a mustache
 *    placeholder, a system-font `font:` keyword, a `font-weight` mention
 *    that is not a plain declaration — makes the result uncertain.
 *  - `font-variation-settings` addresses axes directly; the axes it names
 *    are reported so the default keeps them full (unparsable → `"all"`).
 *
 * The caller passes every text a page can be built from (modules incl.
 * their JS and field defaults, templates, layouts, content values, plugin
 * source) plus the theme, so the editor preview and the deployed site
 * derive the same set from the same data.
 */

import { BASE_TECHNICAL_CSS } from "./base-css.js";
import type { WeightUsage } from "./font-axis-policy.js";
import { renderThemeCss } from "./theme-render.js";
import type { ThemeDocument } from "./themes.js";

/** One text the site is built from; `label` names it in uncertainty reasons. */
export interface FontUsageSource {
  readonly label: string;
  readonly text: string;
}

/** Result of {@link scanSiteFontUsage}. */
export interface SiteFontUsage extends WeightUsage {
  /** Why `weights` is null (first few causes, `label: excerpt`); empty when certain. */
  readonly uncertain: readonly string[];
}

const MAX_REASONS = 5;
const MAX_VAR_DEPTH = 8;
const MAX_EXPANSIONS = 256;

/** Characters that end a declaration value in CSS, attributes, JSON or JS strings. */
const VALUE_END = /[;{}"'`<>\n\\!]/;

/** CSS Fonts 4 §2.2 relative weights. */
function bolder(w: number): number {
  return w < 350 ? 400 : w < 550 ? 700 : w < 900 ? 900 : w;
}
function lighter(w: number): number {
  return w < 100 ? w : w < 550 ? 100 : w < 750 ? 400 : 700;
}

const GLOBAL_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const SYSTEM_FONTS = new Set([
  "caption",
  "icon",
  "menu",
  "message-box",
  "small-caption",
  "status-bar",
]);
const SIZE_KEYWORDS = new Set([
  "xx-small",
  "x-small",
  "small",
  "medium",
  "large",
  "x-large",
  "xx-large",
  "xxx-large",
  "larger",
  "smaller",
]);
const SIZE_TOKEN = /^(?:\d*\.?\d+(?:[a-z]+|%)|0)(?:\/.*)?$|^(?:calc|clamp|min|max)\(/;

interface Scan {
  readonly weights: Set<number>;
  useLighter: boolean;
  readonly reasons: string[];
  axes: Set<string> | "all";
}

function excerpt(text: string, at: number): string {
  return text
    .slice(Math.max(0, at), at + 60)
    .replace(/\s+/g, " ")
    .trim();
}

function uncertain(scan: Scan, label: string, why: string): void {
  if (scan.reasons.length < MAX_REASONS) scan.reasons.push(`${label}: ${why}`);
  else if (scan.reasons.length === MAX_REASONS) scan.reasons.push("…");
}

function valueAfterColon(text: string, from: number): string | null {
  const m = /^\s*:/.exec(text.slice(from, from + 64));
  if (m === null) return null;
  const start = from + m[0].length;
  const rest = text.slice(start, start + 400);
  const end = rest.search(VALUE_END);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function closingParen(value: string, open: number): number {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Custom-property knowledge collected from every source: all declared
 * values per name, and names that are also written in a way we cannot
 * follow (script, `@property`).
 */
interface CustomProps {
  readonly values: Map<string, string[]>;
  readonly opaque: Set<string>;
}

function collectCustomProps(sources: readonly FontUsageSource[]): CustomProps {
  const values = new Map<string, string[]>();
  const opaque = new Set<string>();
  const name = /(?<![\w-])(--[A-Za-z0-9_-]+)/g;
  for (const { text } of sources) {
    for (const m of text.matchAll(name)) {
      const prop = m[1] as string;
      const at = (m.index ?? 0) + prop.length;
      const value = valueAfterColon(text, at);
      if (value !== null) {
        const list = values.get(prop) ?? [];
        list.push(value);
        values.set(prop, list);
        continue;
      }
      const before = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
      if (!/var\(\s*$/.test(before)) opaque.add(prop);
    }
  }
  return { values, opaque };
}

/**
 * Every value `value` can take once its `var()` references are
 * substituted. Returns a reason string when that is not knowable.
 */
function expandVars(value: string, props: CustomProps, depth = 0): string[] | string {
  const at = value.indexOf("var(");
  if (at === -1) return [value];
  if (depth >= MAX_VAR_DEPTH) return "var() nesting too deep";
  const close = closingParen(value, at + 3);
  if (close === -1) return "unbalanced var()";
  const inner = value.slice(at + 4, close);
  const comma = inner.indexOf(",");
  const prop = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  if (props.opaque.has(prop)) return `${prop} is set outside CSS declarations`;
  const candidates = [...(props.values.get(prop) ?? [])];
  if (comma !== -1) candidates.push(inner.slice(comma + 1).trim());
  // No declaration and no fallback: invalid at computed-value time, so the
  // property behaves as `unset` and inherits — it adds no weight.
  const out: string[] = [];
  for (const candidate of candidates) {
    const substituted = `${value.slice(0, at)}${candidate}${value.slice(close + 1)}`;
    const expanded = expandVars(substituted, props, depth + 1);
    if (typeof expanded === "string") return expanded;
    out.push(...expanded);
    if (out.length > MAX_EXPANSIONS) return "too many var() combinations";
  }
  return out;
}

/** Parse a resolved `font-weight` value; returns a reason when it is not plain. */
function addWeightTokens(scan: Scan, value: string): string | null {
  const tokens = value
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  // Empty usually means the value continues past what we can read (a
  // `{{placeholder}}`, a template literal) — not knowable.
  if (tokens.length === 0) return "no readable value";
  for (const token of tokens) {
    if (/^\d+(\.\d+)?$/.test(token)) {
      const n = Number(token);
      if (n < 1 || n > 1000) return `weight ${token} out of range`;
      scan.weights.add(n);
    } else if (token === "normal") scan.weights.add(400);
    else if (token === "bold") scan.weights.add(700);
    else if (token === "lighter") scan.useLighter = true;
    else if (token === "bolder" || GLOBAL_KEYWORDS.has(token)) {
      // bolder: covered by the closure; globals: initial = 400, rest inherit.
    } else return `unrecognised weight '${token}'`;
  }
  return null;
}

/** Tokens of a `font:` shorthand before its size (where the weight lives). */
function addShorthand(scan: Scan, value: string): string | null {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.toLowerCase()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else current += ch;
  }
  if (current) tokens.push(current);
  if (tokens.length === 1 && GLOBAL_KEYWORDS.has(tokens[0] as string)) return null;
  if (tokens.length === 1 && SYSTEM_FONTS.has(tokens[0] as string)) {
    return `system font '${tokens[0]}' (weight chosen by the OS)`;
  }
  for (const token of tokens) {
    if (SIZE_TOKEN.test(token) || SIZE_KEYWORDS.has(token)) return null;
    if (/^\d+(\.\d+)?$/.test(token)) {
      const reason = addWeightTokens(scan, token);
      if (reason !== null) return reason;
    } else if (token === "bold" || token === "lighter" || token === "bolder") {
      addWeightTokens(scan, token);
    }
    // style/variant/stretch keywords and `normal` (= 400, already in) need nothing.
  }
  // A shorthand without a size is invalid CSS and is dropped by the browser.
  return null;
}

function parseVariationSettings(scan: Scan, raw: string): void {
  const value = raw.replace(/["'\\\s]+$/, "").trim();
  if (value === "" || GLOBAL_KEYWORDS.has(value) || value === "normal") return;
  const pair = /^\s*(\\?["'])([A-Za-z0-9 ]{4})\1\s+-?\d*\.?\d+\s*$/;
  const tags: string[] = [];
  for (const part of value.split(",")) {
    const m = pair.exec(part);
    if (m === null) {
      scan.axes = "all";
      return;
    }
    tags.push(m[2] as string);
  }
  if (scan.axes !== "all") for (const t of tags) scan.axes.add(t);
}

function scanSource(scan: Scan, source: FontUsageSource, props: CustomProps): void {
  const { label, text } = source;

  for (const m of text.matchAll(/(?<![\w-])font-weight(?![\w-])/gi)) {
    const at = m.index ?? 0;
    const value = valueAfterColon(text, at + m[0].length);
    if (value === null) {
      uncertain(scan, label, `font-weight used outside a declaration (${excerpt(text, at)})`);
      continue;
    }
    const expanded = expandVars(value, props);
    if (typeof expanded === "string") {
      uncertain(scan, label, `${expanded} (${excerpt(text, at)})`);
      continue;
    }
    for (const v of expanded) {
      const reason = addWeightTokens(scan, v);
      if (reason !== null) uncertain(scan, label, `${reason} (${excerpt(text, at)})`);
    }
  }

  for (const m of text.matchAll(/(?<![\w-])font\s*:/gi)) {
    const at = m.index ?? 0;
    // Start at the colon itself: valueAfterColon consumes it.
    const value = valueAfterColon(text, at + m[0].length - 1);
    if (value === null) continue;
    const expanded = expandVars(value, props);
    if (typeof expanded === "string") {
      uncertain(scan, label, `${expanded} (${excerpt(text, at)})`);
      continue;
    }
    for (const v of expanded) {
      const reason = addShorthand(scan, v);
      if (reason !== null) uncertain(scan, label, `${reason} (${excerpt(text, at)})`);
    }
  }

  for (const m of text.matchAll(/\bfontWeight\b/g)) {
    const at = m.index ?? 0;
    const literal = /^\s*[:=]\s*(?:(["'`])([^"'`\n]{0,20})\1|(\d+))/.exec(text.slice(at + 10));
    const value = literal === null ? null : (literal[2] ?? literal[3] ?? null);
    const reason =
      value === null ? "fontWeight set from script" : addWeightTokens(scan, value.toString());
    if (reason !== null) uncertain(scan, label, `${reason} (${excerpt(text, at)})`);
  }
  if (/\.font\s*=[^=]/.test(text)) {
    uncertain(scan, label, "font shorthand assigned from script");
  }

  for (const m of text.matchAll(/(?<![\w-])font-variation-settings(?![\w-])/gi)) {
    const at = (m.index ?? 0) + m[0].length;
    const colon = /^\s*:/.exec(text.slice(at, at + 64));
    if (colon === null) {
      scan.axes = "all";
      continue;
    }
    const rest = text.slice(at + colon[0].length, at + colon[0].length + 400);
    const end = rest.search(/[;{}<>\n!]/);
    parseVariationSettings(scan, end === -1 ? rest : rest.slice(0, end));
  }
  if (/\bfontVariationSettings\b/.test(text)) scan.axes = "all";
}

/**
 * Derive {@link SiteFontUsage} from the theme and every site text.
 *
 * @param input.sources every module/template/layout/content/plugin text;
 *   the theme's own CSS and the base CSS are added here
 */
export function scanSiteFontUsage(input: {
  readonly tokens: ThemeDocument;
  readonly sources: readonly FontUsageSource[];
}): SiteFontUsage {
  const all: FontUsageSource[] = [
    { label: "theme", text: renderThemeCss(input.tokens) },
    { label: "base-css", text: BASE_TECHNICAL_CSS },
    ...input.sources,
  ];
  const scan: Scan = {
    weights: new Set([400, 700]),
    useLighter: false,
    reasons: [],
    axes: new Set(),
  };
  // Theme typography weights apply to their roles whether or not any CSS
  // references `--font-weight-<role>`; the theme emits them as such vars.
  const themeCss = all[0]?.text ?? "";
  // The name match has no suffix and starts only at a name boundary, so it
  // never backtracks; the value is read with the same bounded reader as
  // every other declaration (a `[name]+:` pattern here is polynomial on
  // runs like `--font-weight---font-weight-...`).
  for (const m of themeCss.matchAll(/(?<![\w-])--font-weight-[A-Za-z0-9_-]+/g)) {
    const value = valueAfterColon(themeCss, (m.index ?? 0) + m[0].length);
    if (value === null) continue;
    const reason = addWeightTokens(scan, value);
    if (reason !== null) uncertain(scan, "theme", reason);
  }
  const props = collectCustomProps(all);
  for (const source of all) scanSource(scan, source, props);

  const axes = scan.axes === "all" ? ("all" as const) : [...scan.axes].sort();
  if (scan.reasons.length > 0) {
    return { weights: null, uncertain: scan.reasons, variationSettingsAxes: axes };
  }
  // Fixed point of the relative-weight closure.
  const closed = new Set(scan.weights);
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of [...closed]) {
      for (const next of scan.useLighter ? [bolder(w), lighter(w)] : [bolder(w)]) {
        if (!closed.has(next)) {
          closed.add(next);
          grew = true;
        }
      }
    }
  }
  return {
    weights: [...closed].sort((a, z) => a - z),
    uncertain: [],
    variationSettingsAxes: axes,
  };
}
