// SPDX-License-Identifier: MPL-2.0

/**
 * #1757, #1760 — how wide a title and a description are in a search
 * result, in pixels, and where a result list cuts them. Search engines cut
 * by width, not by characters: "WWWW" is far wider than "iiii". The widths
 * are Arial's (the face Google's result lists fall back to), in 1/1000 em,
 * at the sizes of a result: title 20 px, description 14 px.
 *
 * The limits are rules of thumb, so they drive write hints and the
 * previews, never findings: Google rewrites most titles and descriptions
 * anyway, and its limits move. A desktop result shows one line of title
 * (about 580 px) and about two lines of description (about 920 px); a
 * phone shows up to two lines of title (about 920 px at the same size)
 * and a shorter description (about 680 px).
 */

/** Arial advance widths of printable ASCII (32–126), 1/1000 em. */
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
] as const;

/** A character outside Latin script (CJK and the like): a full em. */
const WIDE = 1000;
/** Any other character: an average lowercase letter. */
const AVERAGE = 556;

/** The width of one character, 1/1000 em. */
function charUnits(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32] as number;
  // A Latin letter with a mark (é, ü) is as wide as its base letter.
  const base = ch.normalize("NFD").charAt(0);
  const baseCode = base.codePointAt(0) ?? 0;
  if (baseCode >= 32 && baseCode <= 126) return ASCII_WIDTHS[baseCode - 32] as number;
  if (ch === "ß") return 611;
  if (code >= 0x2e80) return WIDE;
  return AVERAGE;
}

/** Font sizes of a result, px. */
export const TITLE_FONT_PX = 20;
export const DESCRIPTION_FONT_PX = 14;

/** Where a result list cuts, px at the sizes above. */
export const SERP_LIMITS = {
  desktop: { title: 580, description: 920 },
  mobile: { title: 920, description: 680 },
} as const;

/** The width of `text` in px at `fontPx`. */
export function textWidthPx(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of text) units += charUnits(ch);
  return Math.round((units * fontPx) / 1000);
}

/**
 * `text` cut to fit `limitPx` at `fontPx` as a result list cuts it: at the
 * last whole word that fits with "…" behind it. The text itself when it
 * fits.
 */
export function cutToWidth(
  text: string,
  fontPx: number,
  limitPx: number,
): {
  readonly text: string;
  readonly cut: boolean;
} {
  const clean = text.replace(/\s+/g, " ").trim();
  if (textWidthPx(clean, fontPx) <= limitPx) return { text: clean, cut: false };
  const room = limitPx - textWidthPx(" …", fontPx);
  let out = "";
  for (const word of clean.split(" ")) {
    const next = out === "" ? word : `${out} ${word}`;
    if (textWidthPx(next, fontPx) > room) break;
    out = next;
  }
  if (out === "") {
    // One word wider than the line: cut it by characters.
    for (const ch of clean) {
      if (textWidthPx(out + ch, fontPx) > room) break;
      out += ch;
    }
  }
  return { text: `${out} …`, cut: true };
}
