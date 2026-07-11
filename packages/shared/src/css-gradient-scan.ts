// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 (CodeQL follow-up) — linear CSS gradient scanner.
 *
 * A `*-gradient\([^;{}]*\)` regex over whole stylesheets is the
 * polynomial-ReDoS shape (#113): on adversarial input full of unclosed
 * `conic-gradient(` starts, every attempt rescans to end-of-input.
 * Gradient arguments legitimately contain nested parens (rgba() stops),
 * so the class can't simply exclude `(`. This scanner walks the string
 * once: find the next `-gradient(` head, then match parens with a
 * depth counter, bounded by a hard argument-length cap.
 */

/** No real gradient needs more; unclosed heads stop scanning here. */
const MAX_GRADIENT_LENGTH = 2_000;

const NEEDLE = "-gradient(";
const BASES = ["linear", "radial", "conic"] as const;
const REPEATING = "repeating-";

export interface CssGradientMatch {
  readonly start: number;
  readonly end: number;
  readonly literal: string;
}

/**
 * All complete gradient literals, in document order. Linear: ONE
 * indexOf needle per hit (each advancing the cursor), a bounded
 * backwards check for the base keyword, and a capped paren walk.
 */
export function scanCssGradients(text: string): CssGradientMatch[] {
  const lower = text.toLowerCase();
  const out: CssGradientMatch[] = [];
  let from = 0;
  while (from < lower.length) {
    const g = lower.indexOf(NEEDLE, from);
    if (g === -1) break;
    let headStart = -1;
    for (const base of BASES) {
      if (g >= base.length && lower.startsWith(base, g - base.length)) {
        headStart = g - base.length;
        break;
      }
    }
    if (headStart === -1) {
      from = g + NEEDLE.length;
      continue;
    }
    if (
      headStart >= REPEATING.length &&
      lower.startsWith(REPEATING, headStart - REPEATING.length)
    ) {
      headStart -= REPEATING.length;
    }
    let depth = 1;
    let i = g + NEEDLE.length;
    const limit = Math.min(lower.length, i + MAX_GRADIENT_LENGTH);
    while (i < limit && depth > 0) {
      const ch = lower.charCodeAt(i);
      if (ch === 40 /* ( */) depth += 1;
      else if (ch === 41 /* ) */) depth -= 1;
      i += 1;
    }
    if (depth === 0) {
      out.push({ start: headStart, end: i, literal: text.slice(headStart, i) });
      from = i;
    } else {
      // Unclosed (or over-long) head — advance past it, never rescan.
      from = g + NEEDLE.length;
    }
  }
  return out;
}

/** Replace each complete gradient via `cb` (return the literal to keep). */
export function replaceCssGradients(text: string, cb: (literal: string) => string): string {
  const matches = scanCssGradients(text);
  if (matches.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + cb(m.literal);
    cursor = m.end;
  }
  return out + text.slice(cursor);
}
