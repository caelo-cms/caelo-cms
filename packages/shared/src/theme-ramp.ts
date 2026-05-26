// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — OKLCh primary-color ramp generator.
 *
 * Given a seed color, derive a 10-stop ramp (`50`,`100`,…,`900`) by
 * walking lightness linearly outward from the seed while preserving its
 * chroma + hue. Anchored so the `500` stop equals the seed.
 *
 * Returns a DTCG group ready to merge at `color.primary`: each stop is
 * a token leaf carrying `$value: "oklch(L C H)"` + `$type: "color"` +
 * `_derived: true` annotation, plus a DTCG alias token at `DEFAULT`
 * pointing at `{color.primary.500}` so existing `--color-primary`
 * references continue to resolve via the v0.11.0 alias resolver.
 *
 * Simplest-possible math (Material 3 inspiration, OKLCh execution); the
 * issue explicitly calls out HCT as future-tuning, not current scope.
 */

import Color from "colorjs.io";
import type { ThemeDocument } from "./themes.js";

/**
 * v0.11.1 — failure surface for the OKLCh ramp generator. Carries the
 * supported color input formats so the AI's next turn can fix the
 * input without round-tripping (CLAUDE.md §11 AI-actionable errors).
 */
export class InvalidSeedColor extends Error {
  readonly kind = "InvalidSeedColor" as const;
  readonly input: string;
  readonly supportedFormats: readonly string[];
  constructor(input: string) {
    const formats = [
      "#rrggbb",
      "#rgb",
      "oklch(L C H)",
      "rgb(r g b)",
      "hsl(h s% l%)",
      "lab(L a b)",
      "lch(L C H)",
    ] as const;
    super(
      `seed color '${input}' is not a recognised CSS color — pass one of: ${formats.join(", ")}.`,
    );
    this.name = "InvalidSeedColor";
    this.input = input;
    this.supportedFormats = formats;
  }
}

/**
 * Linearly-spaced lightness values for the 10 stops. The `500` slot is
 * intentionally a placeholder — the seed's measured lightness replaces
 * it at runtime so the brand color shows up unmodified at its anchor.
 *
 * Curve picked to match Tailwind's perceptual feel: light tints at
 * 50/100 stay near-white, deep shades at 800/900 stay near-black.
 */
const RAMP_KEYS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"] as const;
const RAMP_LIGHTNESS = [0.97, 0.94, 0.87, 0.78, 0.67, 0.55, 0.45, 0.35, 0.25, 0.18] as const;
const SEED_INDEX = RAMP_KEYS.indexOf("500");

/**
 * One ramp stop as a DTCG token leaf. The `_derived: true` annotation
 * is a Caelo extension (sits under DTCG's open `$extensions`-style
 * tolerance) so the admin UI can mark derived stops visually and the
 * operator's explicit overrides can layer cleanly on top.
 */
export interface DerivedRampStop {
  readonly $value: string;
  readonly $type: "color";
  readonly _derived: true;
}

/**
 * Return shape: a DTCG group (`Record<string, DerivedRampStop | alias>`)
 * intended to be merged at `color.primary` plus the list of canonical
 * paths the generator wrote (for echo-back in the propose preview).
 */
export interface RampResult {
  readonly tokens: Record<
    string,
    DerivedRampStop | { $value: string; $type: "color"; _derived: true }
  >;
  readonly derivedPaths: readonly string[];
}

/**
 * Derive a 10-stop OKLCh primary-color ramp from a seed color.
 *
 * @param seedColor — any CSS color string. The seed's chroma + hue are
 *                    preserved; lightness shifts to each ramp stop.
 * @returns A DTCG group ready to write at `color.primary`.
 * @throws InvalidSeedColor when the input doesn't parse as a CSS color.
 */
export function deriveOklchPrimaryRamp(seedColor: string): RampResult {
  if (typeof seedColor !== "string" || seedColor.trim().length === 0) {
    throw new InvalidSeedColor(String(seedColor));
  }
  let seed: Color;
  try {
    seed = new Color(seedColor);
  } catch (_e) {
    throw new InvalidSeedColor(seedColor);
  }
  // Convert to OKLCh; the conversion is lossless within colorjs.io's
  // gamut model (clamps to displayable sRGB on output).
  const oklch = seed.to("oklch");
  const coords = oklch.coords as [number, number, number]; // [L, C, H]
  const seedL = coords[0];
  const chroma = isFinite(coords[1]) ? coords[1] : 0;
  // Achromatic colors (#888, white, black) have NaN hue — preserve 0
  // so the OKLCh string parses; chroma is 0 anyway.
  const hue = isFinite(coords[2]) ? coords[2] : 0;

  const tokens: RampResult["tokens"] = {};
  const derivedPaths: string[] = [];
  for (let i = 0; i < RAMP_KEYS.length; i += 1) {
    const key = RAMP_KEYS[i] as (typeof RAMP_KEYS)[number];
    // Anchor the seed's lightness at the 500 stop; the rest follow the
    // pre-computed curve. Clamp to [0.001, 0.999] so OKLCh emits a
    // valid color (pure black/white can clip chroma in edge cases).
    const rawL = i === SEED_INDEX ? seedL : (RAMP_LIGHTNESS[i] as number);
    const L = Math.max(0.001, Math.min(0.999, rawL));
    const value = formatOklch(L, chroma, hue);
    tokens[key] = { $value: value, $type: "color", _derived: true };
    derivedPaths.push(`color.primary.${key}`);
  }
  // DTCG alias so callers / CSS-vars that reference `color.primary`
  // continue to resolve to the 500 stop. The renderer's alias resolver
  // (v0.11.0) handles the indirection; no renderer changes needed.
  tokens.DEFAULT = {
    $value: "{color.primary.500}",
    $type: "color",
    _derived: true,
  };
  derivedPaths.push("color.primary.DEFAULT");

  return { tokens, derivedPaths };
}

/**
 * Merge a ramp result into a tokens document at `color.primary`,
 * preserving any operator-supplied explicit stops in `overrides`
 * (`{"color.primary.500": "#ff0000"}` keeps the explicit stop AND the
 * derived ramp around it — explicit-wins precedence per Risk §6.2).
 *
 * Returns a fresh document; input is not mutated.
 */
export function mergeRampIntoTokens(
  baseTokens: ThemeDocument,
  ramp: RampResult,
  explicitOverrides: Record<string, unknown>,
): ThemeDocument {
  const out: ThemeDocument = JSON.parse(JSON.stringify(baseTokens));
  const colorGroup = (out as Record<string, unknown>).color as Record<string, unknown> | undefined;
  const nextColor: Record<string, unknown> = { ...(colorGroup ?? {}) };
  // REPLACE the previous color.primary entry with the derived ramp
  // group. The replacement is total — a leaf `{"$value": "…"}` becomes
  // a group `{50: {…}, 100: {…}, …, DEFAULT: {…}}`. Other color tokens
  // (foreground, secondary, etc.) are untouched.
  nextColor.primary = { ...ramp.tokens };
  (out as Record<string, unknown>).color = nextColor;

  // Layer explicit operator-supplied `color.primary.<stop>` overrides
  // on top of the derived ramp. Only `color.primary.*` paths matter
  // here; other overrides flow through the existing applyDtcgWrites
  // call upstream.
  for (const [path, value] of Object.entries(explicitOverrides)) {
    if (!path.startsWith("color.primary.")) continue;
    const stopKey = path.slice("color.primary.".length);
    if (!stopKey || stopKey.includes(".")) continue;
    const primary = (out as { color: { primary: Record<string, unknown> } }).color.primary;
    primary[stopKey] = {
      $value: value,
      $type: "color",
    };
  }
  return out;
}

function formatOklch(L: number, C: number, H: number): string {
  // Three decimal places — enough for visual fidelity (OKLCh's perceptual
  // step is ~0.005L), small enough for cache-friendly stable bytes.
  const fmt = (n: number): string => n.toFixed(3).replace(/\.?0+$/, "") || "0";
  return `oklch(${fmt(L)} ${fmt(C)} ${fmt(H)})`;
}
