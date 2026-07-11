// SPDX-License-Identifier: MPL-2.0

/**
 * issue #150 — web-font resolution primitives.
 *
 * Theme typography tokens name font families (`--font-heading:
 * "Poppins"`), but until #150 nothing delivered the font files to
 * rendered pages — every site silently fell back to system fonts, the
 * exact silent-degradation CLAUDE.md §2 forbids. These pure helpers are
 * the shared half of the fix: extract the families a theme actually
 * uses, classify system stacks (nothing to deliver) vs web fonts
 * (self-hosted at deploy — hotlinking fonts.googleapis.com is both a
 * GDPR liability, LG München I 3 O 17493/20, and a third-party request
 * on the critical path), and build/parse the CSS involved.
 *
 * Network + disk live in `@caelo-cms/admin-core`'s font resolver; the
 * static generator and the preview op share that resolver so preview
 * and production render the same `@font-face` set (parity contract,
 * apps/static-generator/src/generate.ts).
 */

import type { ThemeDocument } from "./themes.js";

/** One family the theme needs delivered, with the weights it uses. */
export interface FontRequest {
  /** Primary family name, unquoted (`Poppins`), first entry of the stack. */
  readonly family: string;
  /** Distinct numeric weights, ascending. Always non-empty. */
  readonly weights: readonly number[];
  /** Typography token names that reference the family (`body`, `heading`). */
  readonly roles: readonly string[];
}

/** A single @font-face declaration parsed from a fonts-CSS payload. */
export interface ParsedFontFace {
  readonly family: string;
  readonly style: string;
  readonly weight: string;
  readonly unicodeRange: string | null;
  /** Remote woff2 URL as served by the fonts source. */
  readonly srcUrl: string;
}

/** A parsed face whose bytes now live at a self-hosted public URL. */
export interface ResolvedFontFace extends Omit<ParsedFontFace, "srcUrl"> {
  readonly publicUrl: string;
}

/**
 * Families that ship with operating systems — nothing to download, no
 * @font-face to emit. Generic CSS keywords included. Lowercased for
 * case-insensitive membership tests.
 */
const SYSTEM_FONT_FAMILIES: ReadonlySet<string> = new Set(
  [
    // Generic keywords + UI stacks
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "ui-rounded",
    "-apple-system",
    "blinkmacsystemfont",
    // Cross-platform classics
    "arial",
    "arial black",
    "helvetica",
    "helvetica neue",
    "georgia",
    "times",
    "times new roman",
    "courier",
    "courier new",
    "verdana",
    "tahoma",
    "trebuchet ms",
    "impact",
    "palatino",
    "garamond",
    // Platform UI/mono staples browsers resolve locally
    "segoe ui",
    "sf pro",
    "sf pro text",
    "sf pro display",
    "sf mono",
    "sfmono-regular",
    "menlo",
    "monaco",
    "consolas",
    "lucida console",
    "lucida sans",
  ].map((f) => f.toLowerCase()),
);

/** True when the family resolves locally on visitors' machines. */
export function isSystemFontFamily(family: string): boolean {
  return SYSTEM_FONT_FAMILIES.has(family.trim().toLowerCase());
}

/** Strip quotes + whitespace from one family in a font stack. */
function cleanFamilyName(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

const KEYWORD_WEIGHTS: Record<string, number> = {
  normal: 400,
  bold: 700,
  // Relative keywords have no absolute value; anchor to the common pair
  // so the request still covers a usable range.
  lighter: 300,
  bolder: 700,
};

const DEFAULT_WEIGHTS = [400, 700] as const;

/**
 * Walk `typography.*` composites and collect every non-system family
 * with the weights the theme declares for it. Alias entries (`$value`
 * as `{other.token}` string) are skipped — they point at a concrete
 * composite that is collected on its own.
 *
 * Only the FIRST family of a declared stack is requested: the rest of
 * the stack is the author's fallback chain, which by definition is not
 * delivered.
 */
export function extractThemeFontRequests(tokens: ThemeDocument): FontRequest[] {
  const typography = (tokens as Record<string, unknown>).typography;
  if (typography === undefined || typography === null || typeof typography !== "object") {
    return [];
  }
  const byFamily = new Map<string, { weights: Set<number>; roles: string[] }>();
  for (const [role, entry] of Object.entries(typography as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const value = (entry as { $value?: unknown }).$value;
    if (value === null || typeof value !== "object") continue; // alias or malformed
    const composite = value as { fontFamily?: unknown; fontWeight?: unknown };
    if (typeof composite.fontFamily !== "string") continue;
    const primary = cleanFamilyName(composite.fontFamily.split(",")[0] ?? "");
    if (primary === "" || isSystemFontFamily(primary)) continue;

    const bucket = byFamily.get(primary) ?? { weights: new Set<number>(), roles: [] };
    if (typeof composite.fontWeight === "number") {
      bucket.weights.add(composite.fontWeight);
    } else if (typeof composite.fontWeight === "string") {
      const mapped = KEYWORD_WEIGHTS[composite.fontWeight];
      if (mapped !== undefined) bucket.weights.add(mapped);
    }
    bucket.roles.push(role);
    byFamily.set(primary, bucket);
  }
  return [...byFamily.entries()].map(([family, b]) => ({
    family,
    weights:
      b.weights.size > 0
        ? [...b.weights].sort((a, z) => a - z)
        : ([...DEFAULT_WEIGHTS] as number[]),
    roles: b.roles,
  }));
}

/** css2 request URL for one family (woff2 negotiated via the UA header). */
export function googleFontsCssUrl(request: FontRequest): string {
  const family = encodeURIComponent(request.family).replace(/%20/g, "+");
  const weights = request.weights.join(";");
  return `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`;
}

/**
 * `[^{}]*` (not `[^}]*`): the char class excluding BOTH braces makes the
 * pattern unambiguous — on adversarial payloads full of unclosed
 * `@font-face{` starts, a failed match aborts at the next `{` instead of
 * rescanning to end-of-input per start position (the polynomial-ReDoS
 * shape CodeQL flags; this file parses remotely-served CSS).
 */
const FONT_FACE_BLOCK_RE = /@font-face\s*\{([^{}]*)\}/g;

/** css2 responses are ~10–50 KB; anything past this is not a fonts CSS. */
const MAX_FONTS_CSS_BYTES = 1_000_000;

function declValue(block: string, prop: string): string | null {
  const m = new RegExp(`${prop}\\s*:\\s*([^;]+);`, "i").exec(block);
  return m ? (m[1] ?? "").trim() : null;
}

/**
 * Parse a fonts-CSS payload (css2 response shape) into face records.
 * Faces without a woff2/woff URL are dropped; a payload yielding zero
 * faces is the caller's loud-failure signal, not a silent empty set.
 * Oversized payloads short-circuit to [] for the same loud path —
 * a legitimate css2 response is orders of magnitude smaller.
 */
export function parseFontsCss(cssText: string): ParsedFontFace[] {
  if (cssText.length > MAX_FONTS_CSS_BYTES) return [];
  const faces: ParsedFontFace[] = [];
  for (const m of cssText.matchAll(FONT_FACE_BLOCK_RE)) {
    const block = m[1] ?? "";
    const familyRaw = declValue(block, "font-family");
    const src = declValue(block, "src");
    if (familyRaw === null || src === null) continue;
    // Capture the whole url(...) argument with an unambiguous class,
    // then check the extension in code — `[^)]+\.woff2?` is the classic
    // ambiguous-suffix polynomial pattern.
    const urlMatch = /url\(([^()]*)\)/i.exec(src);
    if (!urlMatch) continue;
    const srcUrl = (urlMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
    const lower = srcUrl.toLowerCase();
    if (!(lower.endsWith(".woff2") || lower.endsWith(".woff"))) continue;
    faces.push({
      family: cleanFamilyName(familyRaw),
      style: declValue(block, "font-style") ?? "normal",
      weight: declValue(block, "font-weight") ?? "400",
      unicodeRange: declValue(block, "unicode-range"),
      srcUrl,
    });
  }
  return faces;
}

/**
 * Emit self-hosted @font-face CSS. `font-display: swap` always — text
 * must render in the fallback while the woff2 loads.
 */
export function buildFontFaceCss(faces: readonly ResolvedFontFace[]): string {
  return faces
    .map((f) => {
      const range = f.unicodeRange !== null ? `unicode-range:${f.unicodeRange};` : "";
      return (
        `@font-face{font-family:${JSON.stringify(f.family)};` +
        `font-style:${f.style};font-weight:${f.weight};font-display:swap;` +
        `src:url(${f.publicUrl}) format('woff2');${range}}`
      );
    })
    .join("\n");
}

/** Latin-subset heuristic: css2 marks it with a range starting U+0000. */
function isLatinFace(f: ResolvedFontFace): boolean {
  return f.unicodeRange === null || f.unicodeRange.toLowerCase().includes("u+0000");
}

/**
 * Pick the faces worth a `<link rel="preload">`: one per family — the
 * latin, normal-style face at the lowest declared weight (the body-copy
 * face; heavier display cuts arrive via normal loading). Capped at two
 * families so the preload budget stays sane on multi-family themes.
 */
export function selectPreloadFaces(faces: readonly ResolvedFontFace[]): ResolvedFontFace[] {
  const byFamily = new Map<string, ResolvedFontFace[]>();
  for (const f of faces) {
    if (f.style !== "normal" || !isLatinFace(f)) continue;
    const list = byFamily.get(f.family) ?? [];
    list.push(f);
    byFamily.set(f.family, list);
  }
  const picks: ResolvedFontFace[] = [];
  for (const list of byFamily.values()) {
    list.sort((a, z) => Number.parseInt(a.weight, 10) - Number.parseInt(z.weight, 10));
    const first = list[0];
    if (first !== undefined) picks.push(first);
  }
  return picks.slice(0, 2);
}

/**
 * Structured marker for a family that could not be resolved. Lands in
 * `missingSlots` (preview, soft) or a thrown deploy error (hard) — the
 * same loud-signal convention as `theme-asset-unbound:<slot>`.
 */
export function fontUnresolvableMarker(family: string): string {
  return `theme-font-unresolvable:${family}`;
}

/**
 * Filesystem/URL-safe slug for a family name. Shared between the font
 * resolver (writes `<cacheDir>/<slug>/…`) and the admin serve route
 * (reads the same path from the URL) so the two can't drift.
 */
export function fontFamilySlug(family: string): string {
  // After the collapse pass, dash RUNS no longer exist — at most one
  // leading + one trailing dash remain, so the trim pattern needs no
  // quantifier (a `-+$` here is the polynomial-ReDoS shape on
  // adversarial all-dash input; this runs on library-supplied strings).
  return family
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
