// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — WCAG 2.1 contrast helpers for the Colors tab.
 *
 * Computes the contrast ratio between two CSS colors and grades it
 * against the WCAG-AA / AAA thresholds. Backs the ContrastWarning
 * component shown next to each text-on-background swatch pair.
 *
 * Per AC #4: "WCAG-AA contrast warnings (text-on-background ≥ 4.5:1)
 * per swatch pair." We grade on three thresholds matching standard
 * accessibility tooling (axe / Lighthouse):
 *   - AAA = ≥ 7.0 (normal text)
 *   - AA  = ≥ 4.5
 *   - AA Large = ≥ 3.0 (large text only)
 *   - Fail = anything below 3.0
 */

import { parseColor } from "./oklch.js";

export type WcagGrade = "AAA" | "AA" | "AA Large" | "Fail";

/**
 * Compute the WCAG 2.1 relative-luminance contrast ratio between
 * two CSS colors. Returns 1.0 for identical inputs, 21.0 for pure
 * black on pure white. Throws `InvalidColorInput` if either string
 * doesn't parse.
 */
export function wcagContrast(fg: string, bg: string): number {
  const L1 = relativeLuminance(parseColor(fg).srgb);
  const L2 = relativeLuminance(parseColor(bg).srgb);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Map a contrast ratio to the user-facing WCAG grade label. Tested at
 * the threshold boundaries so a ratio of exactly 4.5 reads as "AA",
 * exactly 7.0 as "AAA", etc.
 */
export function wcagBadge(ratio: number): WcagGrade {
  if (!isFinite(ratio) || ratio < 3.0) return "Fail";
  if (ratio < 4.5) return "AA Large";
  if (ratio < 7.0) return "AA";
  return "AAA";
}

/**
 * WCAG 2.1 §1.4.3 relative luminance — sRGB component → linear-light
 * via the standard piecewise transfer + weighted sum. Input is
 * 0..1 sRGB per channel (colorjs.io's coord space).
 */
function relativeLuminance(srgb: readonly [number, number, number]): number {
  const linearise = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const [r, g, b] = srgb.map(linearise) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
