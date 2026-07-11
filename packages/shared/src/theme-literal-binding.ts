// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 2 — mechanical token binding ("AI decides, code
 * executes"). During Genesis materialisation the theme is created FROM
 * the draft's palette, so module CSS copied from the draft contains
 * literals that EQUAL theme token values. Hand-translating them to
 * `var(--…)` is transcription work the model can get subtly wrong;
 * this module does it mechanically:
 *
 *   - colors + gradients whose literal value equals an emitted token's
 *     value are rewritten to `var(--name)` (unambiguous: the value IS
 *     the token's value);
 *   - dimension-ish matches (a `6rem` that equals `--spacing-2xl`) are
 *     reported as SUGGESTIONS only — generic lengths are too ambiguous
 *     to rewrite silently.
 *
 * The value map is parsed from `renderThemeCss` output so binding uses
 * exactly what the renderer emits (aliases resolved, ramps included) —
 * no second resolution path to drift.
 */

import { renderThemeCss } from "./theme-render.js";
import type { ThemeDocument } from "./themes.js";

const VAR_DECL_RE = /(--[a-zA-Z0-9-]+):([^;]+);/g;
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|(?:oklch|rgba?|hsla?|lab|lch|hwb)\([^()]*\)/g;
const GRADIENT_LITERAL_RE = /(?:repeating-)?(?:linear|radial|conic)-gradient\([^;{}]*\)/gi;
const DIMENSION_VALUE_RE = /^-?\d+(\.\d+)?(rem|em|px|%)$/;

export interface ThemeValueMap {
  /** normalized color value → var name (first-declared wins). */
  readonly colors: ReadonlyMap<string, string>;
  /** exact gradient string (normalized whitespace) → var name. */
  readonly gradients: ReadonlyMap<string, string>;
  /** dimension value → var name (suggestion-only tier). */
  readonly dimensions: ReadonlyMap<string, string>;
}

function normalizeColor(v: string): string {
  return v.trim().toLowerCase();
}
function normalizeGradient(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Parse the light-branch declarations the renderer emits for this
 * document into value → var-name maps.
 */
export function buildThemeValueMap(tokens: ThemeDocument): ThemeValueMap {
  const css = renderThemeCss(tokens);
  // Only the light branch: `.dark` overrides carry the same names.
  const lightEnd = css.indexOf(".dark{");
  const light = lightEnd === -1 ? css : css.slice(0, lightEnd);

  const colors = new Map<string, string>();
  const gradients = new Map<string, string>();
  const dimensions = new Map<string, string>();
  for (const m of light.matchAll(VAR_DECL_RE)) {
    const name = m[1] ?? "";
    const value = (m[2] ?? "").trim();
    if (name.startsWith("--gradient-")) {
      const key = normalizeGradient(value);
      if (!gradients.has(key)) gradients.set(key, name);
    } else if (name.startsWith("--color-")) {
      const key = normalizeColor(value);
      if (!colors.has(key)) colors.set(key, name);
    } else if (DIMENSION_VALUE_RE.test(value)) {
      if (!dimensions.has(value)) dimensions.set(value, name);
    }
  }
  return { colors, gradients, dimensions };
}

export interface LiteralBindingResult {
  readonly css: string;
  /** Applied rewrites: literal → var name, with occurrence counts. */
  readonly rewrites: readonly { from: string; to: string; count: number }[];
  /** Dimension matches left in place (too ambiguous to auto-rewrite). */
  readonly suggestions: readonly { literal: string; varName: string }[];
}

/**
 * Rewrite color/gradient literals that equal theme token values to
 * `var(--name)`. Longest-first (gradients before their stop colors) so
 * a gradient binds as a whole instead of stop-by-stop.
 */
export function applyThemeLiteralBinding(css: string, tokens: ThemeDocument): LiteralBindingResult {
  const map = buildThemeValueMap(tokens);
  const counts = new Map<string, { to: string; count: number }>();
  let out = css;

  out = out.replace(GRADIENT_LITERAL_RE, (literal) => {
    const varName = map.gradients.get(normalizeGradient(literal));
    if (varName === undefined) return literal;
    const entry = counts.get(literal) ?? { to: varName, count: 0 };
    entry.count += 1;
    counts.set(literal, entry);
    return `var(${varName})`;
  });

  out = out.replace(COLOR_LITERAL_RE, (literal, offset: number) => {
    // Never rewrite inside an already-produced var(...) fallback or a
    // remaining gradient (a gradient that did NOT match stays literal
    // by decision — rebinding its stops would half-tokenise it).
    const before = out.slice(Math.max(0, offset - 64), offset);
    if (/gradient\([^()]*$/i.test(before)) return literal;
    const varName = map.colors.get(normalizeColor(literal));
    if (varName === undefined) return literal;
    const entry = counts.get(literal) ?? { to: varName, count: 0 };
    entry.count += 1;
    counts.set(literal, entry);
    return `var(${varName})`;
  });

  const suggestions: { literal: string; varName: string }[] = [];
  const seen = new Set<string>();
  for (const m of out.matchAll(/-?\d+(?:\.\d+)?(?:rem|em|px|%)\b/g)) {
    const literal = m[0];
    if (seen.has(literal)) continue;
    seen.add(literal);
    const varName = map.dimensions.get(literal);
    if (varName !== undefined) suggestions.push({ literal, varName });
  }

  return {
    css: out,
    rewrites: [...counts.entries()].map(([from, e]) => ({ from, to: e.to, count: e.count })),
    suggestions,
  };
}

/** Tool-result suffix describing what binding did. Null on no-op. */
export function formatBindingReport(result: LiteralBindingResult): string | null {
  const parts: string[] = [];
  if (result.rewrites.length > 0) {
    const total = result.rewrites.reduce((n, r) => n + r.count, 0);
    parts.push(
      `🔗 bound ${total} literal(s) to theme vars: ${result.rewrites
        .map((r) => `${r.from}→var(${r.to})${r.count > 1 ? `×${r.count}` : ""}`)
        .join(", ")}`,
    );
  }
  if (result.suggestions.length > 0) {
    parts.push(
      `consider tokens for: ${result.suggestions
        .map((s) => `${s.literal}≈var(${s.varName})`)
        .join(", ")} (dimensions are never auto-rewritten)`,
    );
  }
  return parts.length > 0 ? ` ${parts.join(". ")}.` : null;
}
