// SPDX-License-Identifier: MPL-2.0

/**
 * issue #161 tier 2 — the pure half of the design-quality assertion suite.
 *
 * The browser probe (`../design-probe.ts`) collects COMPUTED styles from the
 * published page; everything that decides pass/fail lives here so it is
 * unit-tested under `bun test` without a browser or a model in the loop.
 *
 * Every check is deliberately conservative: this suite gates every PR
 * against a live model, so a threshold only fails on the regression class
 * it names (monochrome page, flat type scale, unloaded webfont, template
 * leak), never on a legitimate stylistic choice. Each function returns a
 * list of human-readable violations — empty means pass — so the scenario
 * can print all of them at once instead of stopping at the first.
 */

/** An sRGB color with 0–255 channels and 0–1 alpha. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** RGB spread at or below this reads as gray — same bound as the #112 primary check. */
export const NEUTRAL_RGB_SPREAD = 24;

/** Below this alpha a color contributes nothing visible. */
const VISIBLE_ALPHA = 0.1;

const clamp255 = (v: number): number => Math.round(Math.min(255, Math.max(0, v * 255)));

/** Linear-light sRGB channel → gamma-encoded 0–1. */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function oklabToRgba(l: number, a: number, b: number, alpha: number): Rgba {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp255(linearToSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: clamp255(linearToSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: clamp255(linearToSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
    a: alpha,
  };
}

/** CIE Lab (D50, as CSS defines it) → sRGB. */
function labToRgba(l: number, a: number, b: number, alpha: number): Rgba {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const xr = fx ** 3 > eps ? fx ** 3 : (116 * fx - 16) / kappa;
  const yr = l > kappa * eps ? fy ** 3 : l / kappa;
  const zr = fz ** 3 > eps ? fz ** 3 : (116 * fz - 16) / kappa;
  // D50 white point, then Bradford-adapted D50 → linear sRGB (D65).
  const x = xr * 0.96422;
  const y = yr;
  const z = zr * 0.82521;
  return {
    r: clamp255(linearToSrgb(3.1341359569 * x - 1.6173863321 * y - 0.490661946 * z)),
    g: clamp255(linearToSrgb(-0.9787985 * x + 1.9161301 * y + 0.0334454 * z)),
    b: clamp255(linearToSrgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z)),
    a: alpha,
  };
}

/** Parse one numeric CSS component; `%` maps onto `percentScale`. */
function num(token: string | undefined, percentScale: number): number {
  if (token === undefined) throw new Error("missing color component");
  if (token === "none") return 0;
  if (token.endsWith("%")) return (Number.parseFloat(token) / 100) * percentScale;
  const n = Number.parseFloat(token);
  if (Number.isNaN(n)) throw new Error(`not a number: ${token}`);
  return n;
}

/** Split `a b c / d` or `a, b, c, d` into components + alpha token. */
function components(body: string): { parts: string[]; alpha: string | undefined } {
  const [main, slashAlpha] = body.split("/");
  const parts = (main ?? "").replace(/,/g, " ").trim().split(/\s+/);
  if (slashAlpha !== undefined) return { parts, alpha: slashAlpha.trim() };
  // Legacy comma syntax carries alpha as a fourth component.
  if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
  return { parts, alpha: undefined };
}

/**
 * Parse a COMPUTED CSS color (what `getComputedStyle` returns) into sRGB.
 *
 * Chromium serialises legacy colors as `rgb()/rgba()` but keeps modern
 * spaces (`oklch()`, `oklab()`, `lab()`, `lch()`, `color(...)`) in their own
 * notation, and the AI authors oklch palettes routinely — so all of them
 * must be understood. `color(display-p3 …)` is read as sRGB: the gamut
 * difference is irrelevant for the distinct/neutral decisions made here.
 * Anything else throws (CLAUDE.md §2): an unknown format must extend this
 * parser, not silently drop out of the color-variety count.
 */
export function parseComputedColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const fn = /^([a-z-]+)\((.*)\)$/.exec(v);
  if (!fn) throw new Error(`parseComputedColor: unrecognised color "${value}"`);
  const name = fn[1] ?? "";
  const body = fn[2] ?? "";
  try {
    switch (name) {
      case "rgb":
      case "rgba": {
        const { parts, alpha } = components(body);
        return {
          r: Math.round(num(parts[0], 255)),
          g: Math.round(num(parts[1], 255)),
          b: Math.round(num(parts[2], 255)),
          a: alpha === undefined ? 1 : num(alpha, 1),
        };
      }
      case "oklab": {
        const { parts, alpha } = components(body);
        return oklabToRgba(
          num(parts[0], 1),
          num(parts[1], 0.4),
          num(parts[2], 0.4),
          alpha === undefined ? 1 : num(alpha, 1),
        );
      }
      case "oklch": {
        const { parts, alpha } = components(body);
        const c = num(parts[1], 0.4);
        const h = (num(parts[2], 1) * Math.PI) / 180;
        return oklabToRgba(
          num(parts[0], 1),
          c * Math.cos(h),
          c * Math.sin(h),
          alpha === undefined ? 1 : num(alpha, 1),
        );
      }
      case "lab": {
        const { parts, alpha } = components(body);
        return labToRgba(
          num(parts[0], 100),
          num(parts[1], 125),
          num(parts[2], 125),
          alpha === undefined ? 1 : num(alpha, 1),
        );
      }
      case "lch": {
        const { parts, alpha } = components(body);
        const c = num(parts[1], 150);
        const h = (num(parts[2], 1) * Math.PI) / 180;
        return labToRgba(
          num(parts[0], 100),
          c * Math.cos(h),
          c * Math.sin(h),
          alpha === undefined ? 1 : num(alpha, 1),
        );
      }
      case "color": {
        // No legacy comma form here: alpha only ever follows a slash, and
        // the leading space name would otherwise read as a fourth channel.
        const [main, slashAlpha] = body.split("/");
        const parts = (main ?? "").trim().split(/\s+/);
        const alpha = slashAlpha?.trim();
        const space = parts.shift();
        const a = alpha === undefined ? 1 : num(alpha, 1);
        if (space === "srgb" || space === "display-p3") {
          return {
            r: clamp255(num(parts[0], 1)),
            g: clamp255(num(parts[1], 1)),
            b: clamp255(num(parts[2], 1)),
            a,
          };
        }
        if (space === "srgb-linear") {
          return {
            r: clamp255(linearToSrgb(num(parts[0], 1))),
            g: clamp255(linearToSrgb(num(parts[1], 1))),
            b: clamp255(linearToSrgb(num(parts[2], 1))),
            a,
          };
        }
        throw new Error(`unsupported color() space "${space}"`);
      }
      default:
        throw new Error(`unsupported color function "${name}"`);
    }
  } catch (e) {
    throw new Error(`parseComputedColor: cannot read "${value}": ${(e as Error).message}`);
  }
}

/** True when the color is (near-)invisible. */
export function isTransparent(c: Rgba): boolean {
  return c.a < VISIBLE_ALPHA;
}

/** True when the color reads as gray/black/white (RGB spread ≤ 24). */
export function isNeutral(c: Rgba): boolean {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= NEUTRAL_RGB_SPREAD;
}

/** Euclidean distance in 0–255 sRGB space. */
export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/**
 * Browser default link colors (`:link` #0000ee, `:visited` #551a8b). An
 * unstyled anchor paints them, so they prove the ABSENCE of design and
 * must not count toward palette use.
 */
const UA_DEFAULT_LINK_COLORS: readonly Rgba[] = [
  { r: 0, g: 0, b: 238, a: 1 },
  { r: 85, g: 26, b: 139, a: 1 },
];

/**
 * Count visible, non-neutral colors that are mutually more than
 * `minDistance` apart (greedy clustering — a primary and its hover shade
 * collapse into one, a primary and an accent stay two). Browser-default
 * link colors are skipped.
 */
export function distinctChromaticColors(values: readonly string[], minDistance = 40): Rgba[] {
  const kept: Rgba[] = [];
  for (const v of values) {
    const c = parseComputedColor(v);
    if (isTransparent(c) || isNeutral(c)) continue;
    if (UA_DEFAULT_LINK_COLORS.some((d) => colorDistance(d, c) < 1)) continue;
    if (kept.every((k) => colorDistance(k, c) > minDistance)) kept.push(c);
  }
  return kept;
}

/** Computed backgrounds of one top-level page section. */
export interface SectionBackground {
  /** Short selector-ish label for messages (`header`, `section:nth(2)`). */
  readonly label: string;
  readonly backgroundColor: string;
  /** Computed `background-image` — `none` or a gradient/url. */
  readonly backgroundImage: string;
}

/** Computed colors sampled from the rendered page. */
export interface ColorSample {
  /** Effective page background (body, or html when body is transparent). */
  readonly pageBackground: string;
  /** `color` / `background-color` / `border-color` of visible elements. */
  readonly usedColors: readonly string[];
  readonly sections: readonly SectionBackground[];
}

/**
 * issue #161 — color variety. Fails on the flat page: fewer than
 * `minChromatic` distinct non-neutral colors actually RENDERED (the theme
 * palette check on main only proves the tokens exist, not that modules
 * use them), or every section sitting on the page background with no
 * gradient/image (no visual rhythm between sections).
 */
export function checkColorVariety(sample: ColorSample, minChromatic = 2): string[] {
  const violations: string[] = [];
  const distinct = distinctChromaticColors(sample.usedColors);
  if (distinct.length < minChromatic) {
    violations.push(
      `rendered page uses ${distinct.length} distinct chromatic color(s), need ≥${minChromatic} — modules ignore the theme palette (flat/monochrome page)`,
    );
  }
  const page = parseComputedColor(sample.pageBackground);
  const differs = sample.sections.some((s) => {
    if (s.backgroundImage.trim() !== "none" && s.backgroundImage.trim() !== "") return true;
    const bg = parseComputedColor(s.backgroundColor);
    return !isTransparent(bg) && colorDistance(bg, page) > 8;
  });
  if (sample.sections.length === 0) {
    violations.push(
      "no top-level sections found to compare backgrounds (probe found no header/section/footer)",
    );
  } else if (!differs) {
    violations.push(
      `all ${sample.sections.length} top-level sections sit on the page background (${sample.pageBackground}) with no gradient/image — no section rhythm`,
    );
  }
  return violations;
}

/** Computed font sizes (px) of the text levels on the page. */
export interface TypeSample {
  readonly h1Px: readonly number[];
  readonly h2Px: readonly number[];
  /** Visible `<p>` sizes — body text as visitors see it. */
  readonly paragraphPx: readonly number[];
}

/** h1 must be at least this many times the body size. */
export const MIN_H1_BODY_RATIO = 1.5;

/** Median of a non-empty list. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error("median of empty list");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * issue #161 — type hierarchy. Compares the LARGEST h1 against the MEDIAN
 * h2 and the median paragraph: medians keep one oversized CTA-band h2 or
 * one small caption from deciding the verdict. A page without an h2 only
 * checks h1 over body (a single-section page is legitimate).
 */
export function checkTypeHierarchy(sample: TypeSample): string[] {
  const violations: string[] = [];
  if (sample.h1Px.length === 0) return ["no visible <h1> on the page"];
  if (sample.paragraphPx.length === 0) return ["no visible <p> on the page to measure body text"];
  const h1 = Math.max(...sample.h1Px);
  const body = median(sample.paragraphPx);
  if (h1 / body < MIN_H1_BODY_RATIO) {
    violations.push(
      `h1 ${h1}px is only ${(h1 / body).toFixed(2)}× body ${body}px (need ≥${MIN_H1_BODY_RATIO}×) — flat type scale`,
    );
  }
  if (sample.h2Px.length > 0) {
    const h2 = median(sample.h2Px);
    if (!(h1 > h2)) violations.push(`h1 ${h1}px is not larger than h2 ${h2}px (median)`);
    if (!(h2 > body)) violations.push(`h2 ${h2}px (median) is not larger than body ${body}px`);
  }
  return violations;
}

/** First family of a computed `font-family` stack, unquoted + lowercased. */
export function primaryFamily(fontFamily: string): string {
  return (fontFamily.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

/** What the browser reports about fonts on the rendered page. */
export interface FontSample {
  /** Families of `document.fonts` faces whose status is `loaded`. */
  readonly loadedFamilies: readonly string[];
  readonly h1FontFamily: string;
  readonly bodyFontFamily: string;
}

/**
 * issue #161 / #150 — web fonts actually delivered. Only applies when the
 * theme declares a non-system family (`declaredWebFamilies` empty ⇒ pass:
 * a system stack is a legitimate choice, logged by the design report).
 * Passes when at least one declared family is both LOADED and the primary
 * computed family of the h1 or the body text — i.e. the font the theme
 * names is what visitors see, not the fallback stack.
 */
export function checkWebFontsDelivered(
  declaredWebFamilies: readonly string[],
  sample: FontSample,
): string[] {
  if (declaredWebFamilies.length === 0) return [];
  const declared = declaredWebFamilies.map((f) => f.toLowerCase());
  const loaded = new Set(sample.loadedFamilies.map(primaryFamily));
  const rendered = new Set([
    primaryFamily(sample.h1FontFamily),
    primaryFamily(sample.bodyFontFamily),
  ]);
  const delivered = declared.filter((f) => loaded.has(f) && rendered.has(f));
  if (delivered.length > 0) return [];
  return [
    `theme declares web font(s) ${declaredWebFamilies.join(", ")} but none is both loaded (document.fonts: ${[...loaded].join(", ") || "none"}) and rendered on h1/body (h1: ${sample.h1FontFamily}; body: ${sample.bodyFontFamily}) — font delivery regression (#150)`,
  ];
}

const RAW_TEXT_OPEN_RE = /<(script|style)\b/gi;
const CLOSE_TAG_TAIL_RE = /^\s*>/;

/**
 * The HTML outside `<script>` / `<style>` element bodies, as a list of
 * segments. A linear scan instead of a strip-by-`replace`: one replace pass
 * over `<scr<script></script>ipt>` would re-form a `<script` from the
 * leftovers (CodeQL js/incomplete-multi-character-sanitization), and an
 * unterminated element keeps its tail visible so a leak inside it is still
 * reported rather than silently dropped.
 */
function segmentsOutsideScriptAndStyle(html: string): string[] {
  const lower = html.toLowerCase();
  const segments: string[] = [];
  let cursor = 0;
  RAW_TEXT_OPEN_RE.lastIndex = 0;
  for (;;) {
    const open = RAW_TEXT_OPEN_RE.exec(html);
    if (open === null) break;
    const openTagEnd = html.indexOf(">", open.index);
    const end =
      openTagEnd === -1
        ? -1
        : findCloseTagEnd(lower, open[0].slice(1).toLowerCase(), openTagEnd + 1);
    if (end === -1) break;
    segments.push(html.slice(cursor, open.index));
    cursor = end;
    RAW_TEXT_OPEN_RE.lastIndex = end;
  }
  segments.push(html.slice(cursor));
  return segments;
}

/** Index just past the `</name\s*>` that closes a raw-text element, or -1. */
function findCloseTagEnd(lower: string, name: string, from: number): number {
  const closeOpen = `</${name}`;
  for (let at = lower.indexOf(closeOpen, from); at !== -1; at = lower.indexOf(closeOpen, at + 1)) {
    const tailStart = at + closeOpen.length;
    const tail = CLOSE_TAG_TAIL_RE.exec(lower.slice(tailStart, tailStart + 64));
    if (tail !== null) return tailStart + tail[0].length;
  }
  return -1;
}
const MUSTACHE_TAG_RE = /\{\{\s*[#/^!>&]?\s*[A-Za-z_][\w.-]*\s*\}\}/g;
const MISSING_MARKER_RE = /<!--\s*caelo:missing[^>]*-->/g;

/**
 * issue #161 / #70 / #71 — template leaks in SERVED HTML: any literal
 * mustache tag (`{{title}}`, `{{#items}}`, an unbound `{{theme_logo_url}}`)
 * or a `caelo:missing` marker comment. Script and style element bodies
 * are skipped — inline JS legitimately contains `{{`/`}}` runs — while
 * attributes (an unresolved `src="{{…}}"`) are still scanned. Returns the
 * distinct offending snippets.
 */
export function findTemplateLeaks(html: string): string[] {
  const hits = new Set<string>();
  for (const visible of segmentsOutsideScriptAndStyle(html)) {
    for (const m of visible.matchAll(MUSTACHE_TAG_RE)) hits.add(m[0]);
    for (const m of visible.matchAll(MISSING_MARKER_RE)) hits.add(m[0].slice(0, 120));
  }
  return [...hits];
}

/** Computed styles of one element, keyed by CSS property. */
export type StyleSnapshot = Readonly<Record<string, string>>;

/**
 * issue #161 — cross-page consistency. Compares the same role (primary
 * CTA, section heading) on two pages. Properties listed in
 * `relativeTolerance` may differ by that fraction (font-size under fluid
 * `clamp()` scales); everything else must match exactly. Colors are
 * compared as parsed sRGB so `rgb(…)` vs `oklch(…)` serialisations of the
 * same token do not fail.
 */
export function compareStyleSnapshots(
  role: string,
  a: StyleSnapshot,
  b: StyleSnapshot,
  relativeTolerance: Readonly<Record<string, number>> = {},
): string[] {
  const violations: string[] = [];
  for (const prop of Object.keys(a)) {
    const av = a[prop] ?? "";
    const bv = b[prop];
    if (bv === undefined) {
      violations.push(`${role}: property ${prop} missing on the second page`);
      continue;
    }
    const tol = relativeTolerance[prop];
    if (tol !== undefined) {
      const an = Number.parseFloat(av);
      const bn = Number.parseFloat(bv);
      if (Math.abs(an - bn) > tol * Math.max(an, bn)) {
        violations.push(`${role}: ${prop} ${av} vs ${bv} (beyond ±${tol * 100}%)`);
      }
      continue;
    }
    if (prop.includes("color")) {
      if (colorDistance(parseComputedColor(av), parseComputedColor(bv)) > 2) {
        violations.push(`${role}: ${prop} ${av} vs ${bv}`);
      }
      continue;
    }
    const norm = prop === "font-family" ? primaryFamily : (s: string) => s.trim();
    if (norm(av) !== norm(bv)) violations.push(`${role}: ${prop} ${av} vs ${bv}`);
  }
  return violations;
}

/** A clickable element the probe found in the page's main content. */
export interface CtaCandidate {
  readonly text: string;
  readonly styles: StyleSnapshot;
}

/**
 * The page's primary CTA: the first main-content link/button (document
 * order) painted with a visible CHROMATIC background. Outline/ghost and
 * neutral buttons are secondary by definition; nav links never reach the
 * candidate list. Null when the page has no filled chromatic button.
 */
export function pickPrimaryCta(candidates: readonly CtaCandidate[]): CtaCandidate | null {
  for (const c of candidates) {
    const bg = c.styles["background-color"];
    if (bg === undefined) continue;
    const color = parseComputedColor(bg);
    if (!isTransparent(color) && !isNeutral(color)) return c;
  }
  return null;
}
