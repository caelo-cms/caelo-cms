// SPDX-License-Identifier: MPL-2.0

/**
 * The unicode-range slices Caelo splits a web font into at build time.
 *
 * These are the script ranges Google Fonts' css2 API serves for Latin,
 * Greek and Cyrillic families. Using the same slices keeps the pinned
 * registry path byte-for-byte comparable with the css2 path in the
 * static generator, and browsers already know how to treat them: a slice
 * is downloaded only when the page contains a character in its range.
 *
 * The slices are fixed per toolchain version — never derived from site
 * content — so editing a page or adding a translation never changes a
 * font file (cache stays warm, CDN stays warm, no per-text subsets).
 *
 * Declaration order matters. When ranges overlap (U+0304, U+0308, ...)
 * the browser picks the face declared LAST, so the list runs from the
 * least to the most commonly needed slice, as css2 does: `latin` is
 * last.
 */

/** One named unicode-range slice. */
export interface UnicodeSubset {
  /** Stable slice name; part of the derived file name. */
  readonly name: string;
  /** CSS `unicode-range` value, also the code points the slice keeps. */
  readonly unicodeRange: string;
}

/** Name of the catch-all slice for code points no named slice covers. */
export const OTHER_SUBSET = "other";

export const UNICODE_SUBSETS: readonly UnicodeSubset[] = [
  {
    name: "cyrillic-ext",
    unicodeRange: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
  },
  {
    name: "cyrillic",
    unicodeRange: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  },
  { name: "greek-ext", unicodeRange: "U+1F00-1FFF" },
  {
    name: "greek",
    unicodeRange: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF",
  },
  {
    name: "vietnamese",
    unicodeRange:
      "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
  },
  {
    name: "latin-ext",
    unicodeRange:
      "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
  },
  {
    name: "latin",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
];

/** Inclusive code point interval. */
export type CodePointRange = readonly [number, number];

/**
 * Parse a CSS `unicode-range` value (`U+0000-00FF, U+0131`) into
 * inclusive intervals. Wildcards (`U+4??`) are not used by any slice and
 * are rejected rather than half-supported.
 */
export function parseUnicodeRange(value: string): CodePointRange[] {
  return value.split(",").map((part) => {
    const m = /^\s*U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?\s*$/.exec(part);
    if (!m) throw new Error(`UnicodeRangeInvalid:${part.trim()}`);
    const lo = Number.parseInt(m[1] ?? "", 16);
    const hi = m[2] === undefined ? lo : Number.parseInt(m[2], 16);
    if (hi < lo) throw new Error(`UnicodeRangeInvalid:${part.trim()}`);
    return [lo, hi] as const;
  });
}

/** True when `cp` falls inside any of `ranges`. */
export function inRanges(cp: number, ranges: readonly CodePointRange[]): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function hex(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Format sorted, de-duplicated code points as a compact CSS
 * `unicode-range` (consecutive runs collapse to `U+XXXX-YYYY`).
 */
export function formatUnicodeRange(sortedCodePoints: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < sortedCodePoints.length) {
    const start = sortedCodePoints[i] as number;
    let end = start;
    while (sortedCodePoints[i + 1] === end + 1) {
      end++;
      i++;
    }
    parts.push(start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
    i++;
  }
  return parts.join(", ");
}

/** One slice to cut: its name, CSS range, and the face's code points in it. */
export interface SlicePlan {
  readonly name: string;
  readonly unicodeRange: string;
  readonly codePoints: readonly number[];
}

/**
 * Decide which slices a face is cut into, in CSS declaration order.
 *
 * A named slice is emitted when the face has a code point that ONLY that
 * slice covers — a Latin face that happens to map U+0301 (combining
 * acute, listed under both `cyrillic` and `vietnamese`) does not "cover
 * Cyrillic" and gets no Cyrillic file. Shared code points are still never
 * lost: a skipped slice is re-admitted when one of its code points would
 * otherwise be in no emitted slice. Code points outside every named slice
 * go to one `other` slice whose range lists exactly those code points, so
 * the delivered set always covers everything the source face maps.
 *
 * @param charset the face's mapped code points, sorted ascending
 */
export function planSlices(charset: readonly number[]): SlicePlan[] {
  const all = UNICODE_SUBSETS.map((s) => {
    const ranges = parseUnicodeRange(s.unicodeRange);
    return { ...s, ranges, codePoints: charset.filter((cp) => inRanges(cp, ranges)) };
  });
  const named = all.filter((s) => s.codePoints.length > 0);
  const owners = (cp: number) => named.filter((s) => inRanges(cp, s.ranges)).length;
  const emitted = new Set(named.filter((s) => s.codePoints.some((cp) => owners(cp) === 1)));
  const covered = (cp: number) => [...emitted].some((s) => inRanges(cp, s.ranges));
  // Re-admit greedily from the most commonly needed slice (declared last)
  // down, so a shared code point rides in the slice a page most likely
  // downloads anyway.
  for (const s of [...named].reverse()) {
    if (!emitted.has(s) && s.codePoints.some((cp) => !covered(cp))) emitted.add(s);
  }
  const uncovered = charset.filter((cp) => !all.some((s) => inRanges(cp, s.ranges)));
  return [
    ...(uncovered.length > 0
      ? [{ name: OTHER_SUBSET, unicodeRange: formatUnicodeRange(uncovered), codePoints: uncovered }]
      : []),
    ...named
      .filter((s) => emitted.has(s))
      .map(({ name, unicodeRange, codePoints }) => ({ name, unicodeRange, codePoints })),
  ];
}
