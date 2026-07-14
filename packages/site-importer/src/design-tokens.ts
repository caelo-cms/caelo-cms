// SPDX-License-Identifier: MPL-2.0

/**
 * issue #247 (WS1) — computed-style design-token sampling.
 *
 * During the same Playwright render pass that captures the source
 * screenshot, a small in-page script samples `getComputedStyle` on
 * representative elements (body, h1-h3, p, a, nav, footer, the most
 * prominent button). This module holds:
 *
 *   - the browser-side collection script (dumb: read properties, return
 *     raw records — no classification in the page),
 *   - the PURE derivation from raw samples to a compact, deterministic
 *     design-token JSON (a few KB max),
 *   - the PURE site-level aggregation across pages,
 *   - the PURE flattening into `{token, value, scope}` tuples that
 *     `imports.compose_from_run` merges over the extractor's
 *     inline-CSS-derived tokens.
 *
 * Deliberately NOT here: any parsing/purging of source stylesheets.
 * Raw CSS is bloat we never replay (epic #252 non-goal); computed
 * styles are the effective ground truth in ~2 KB.
 */

/** Roles the in-page script samples, in a fixed, deterministic order. */
export const SAMPLE_ROLES = [
  "body",
  "h1",
  "h2",
  "h3",
  "p",
  "a",
  "nav",
  "footer",
  "button",
  // issue #32 — spacing-bearing roles. These carry the rhythm signal
  // (section vertical padding, container gutter, card padding) that
  // `deriveDesignTokens` folds into the `spacing` scale. They also add
  // colour/font evidence to the palette like any other sampled element.
  "section",
  "container",
  "card",
] as const;

export type SampleRole = (typeof SAMPLE_ROLES)[number];

/** One element's raw computed-style record, as returned by the browser. */
export interface ElementStyleSample {
  readonly role: SampleRole;
  /** camelCase computed-style properties (color, backgroundColor, …). */
  readonly styles: Readonly<Record<string, string>>;
}

/** `{value, count}` pair — deduped values ordered by descending frequency. */
export interface TokenFrequency {
  readonly value: string;
  readonly count: number;
}

/**
 * Compact per-page design-token summary. Every array is deduped,
 * frequency-ordered (count desc, then value asc for determinism) and
 * capped, so the whole JSON stays a few KB.
 */
export interface PageDesignTokens {
  /** Text + background colors, normalised to hex. */
  readonly palette: readonly TokenFrequency[];
  /** Background colors only (subset of palette, kept separate because
   *  surface colors drive theme background decisions). */
  readonly backgrounds: readonly TokenFrequency[];
  /** Full font stacks as the browser resolved them. */
  readonly fontFamilies: readonly TokenFrequency[];
  readonly fontSizes: readonly TokenFrequency[];
  readonly fontWeights: readonly TokenFrequency[];
  /** Non-zero border radii. */
  readonly radii: readonly TokenFrequency[];
  /** Non-`none` box shadows, most frequent first. */
  readonly shadows: readonly TokenFrequency[];
  /**
   * issue #32 — measured spacing scale (`space-*` in the flattened
   * tokens). Keys are a small, stable set — `section` (vertical section
   * rhythm), `container` (horizontal gutter), `card` (card inner
   * padding), `button` (button inner padding). Each value is the most
   * frequent non-zero computed length for that metric on the page. A
   * metric with no non-zero sample is ABSENT — never defaulted
   * (CLAUDE.md §2 no-fallbacks).
   */
  readonly spacing: Readonly<Record<string, string>>;
  /** First (most prominent) sample per role → its key properties. */
  readonly roles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Site-level aggregate over every page's sampled tokens. */
export interface SiteDesignTokens extends PageDesignTokens {
  /** How many pages contributed samples (transparency for the AI). */
  readonly pageCount: number;
}

/**
 * Browser-side collection script, evaluated via `page.evaluate` in the
 * SAME session that takes the source screenshot. A string (not a
 * function) so this package needs no DOM typings and no bundler can
 * try to transform it. Returns `ElementStyleSample[]`.
 *
 * Sampling plan (fixed instance caps keep output deterministic + small):
 * body ×1, h1 ×3, h2 ×5, h3 ×5, p ×10, a ×20, nav ×2, footer ×1, plus
 * the most prominent button-like element (largest visible area; ties
 * break on document order) ×3.
 */
export const COLLECT_STYLE_SAMPLES_SCRIPT = `(() => {
  const PROPS = [
    ["color", "color"],
    ["background-color", "backgroundColor"],
    ["font-family", "fontFamily"],
    ["font-size", "fontSize"],
    ["font-weight", "fontWeight"],
    ["line-height", "lineHeight"],
    ["border-radius", "borderRadius"],
    ["box-shadow", "boxShadow"],
    // issue #32 — spacing longhands. getComputedStyle always resolves
    // these to px, so downstream derivation sees a single CSS length.
    ["padding-top", "paddingTop"],
    ["padding-bottom", "paddingBottom"],
    ["padding-left", "paddingLeft"],
    ["padding-right", "paddingRight"],
    ["gap", "gap"],
  ];
  const read = (el) => {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const [prop, key] of PROPS) styles[key] = cs.getPropertyValue(prop);
    return styles;
  };
  const out = [];
  const take = (role, selector, limit) => {
    const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
    for (const el of els) {
      try { out.push({ role, styles: read(el) }); } catch { /* detached node */ }
    }
  };
  take("body", "body", 1);
  take("h1", "h1", 3);
  take("h2", "h2", 5);
  take("h3", "h3", 5);
  take("p", "p", 10);
  take("a", "a[href]", 20);
  take("nav", "nav", 2);
  take("footer", "footer", 1);
  // issue #32 — spacing-bearing roles.
  // Sections carry the vertical rhythm; rank by rendered area so the
  // real content sections win over tiny nav sub-sections, then take a
  // handful (frequency across them + across pages resolves the scale).
  const sectionEls = Array.from(document.querySelectorAll(
    'main > section, main > div, body > section, section, [class*="section" i]'
  ));
  const rankedSections = sectionEls
    .map((el) => { const r = el.getBoundingClientRect(); return { el, area: r.width * r.height }; })
    .filter((c) => c.area > 0)
    .sort((x, y) => y.area - x.area)
    .slice(0, 6);
  for (const c of rankedSections) {
    try { out.push({ role: "section", styles: read(c.el) }); } catch { /* detached node */ }
  }
  // Containers carry the horizontal gutter (page side padding).
  take("container", 'main, [class*="container" i], [class*="wrapper" i]', 4);
  // Cards carry a representative inner padding.
  take("card", '[class*="card" i], article, [class*="tile" i]', 8);
  // Most prominent button-like element: real buttons, ARIA buttons,
  // submit inputs, and anchors whose class smells like a CTA. Rank by
  // rendered area; document order breaks ties (querySelectorAll is
  // document-ordered and sort is stable).
  const candidates = Array.from(document.querySelectorAll(
    'button, [role="button"], input[type="submit"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i]'
  ));
  const ranked = candidates
    .map((el) => { const r = el.getBoundingClientRect(); return { el, area: r.width * r.height }; })
    .filter((c) => c.area > 0)
    .sort((x, y) => y.area - x.area)
    .slice(0, 3);
  for (const c of ranked) {
    try { out.push({ role: "button", styles: read(c.el) }); } catch { /* detached node */ }
  }
  return out;
})()`;

// ── Pure derivation ─────────────────────────────────────────────────

/** Caps per list so the summary never balloons past a few KB. */
const CAPS = {
  palette: 12,
  backgrounds: 8,
  fontFamilies: 6,
  fontSizes: 10,
  fontWeights: 6,
  radii: 6,
  shadows: 3,
} as const;

/**
 * Normalise a computed color to lowercase hex (`#rrggbb`, or
 * `#rrggbbaa` when translucent). Returns null for fully transparent or
 * unparseable values — those carry no palette information.
 */
export function normalizeColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "transparent" || v === "none") return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  // Collapse runs of whitespace BEFORE matching — the separator
  // pattern is then unambiguous, which keeps the regex linear
  // (CodeQL js/polynomial-redos on the previous `\s*[, ]\s*` form:
  // overlapping quantifiers backtracked polynomially on long spaces).
  const canon = v.replace(/\s+/g, " ");
  const m = canon.match(
    /^rgba?\( ?(\d{1,3}) ?[, ] ?(\d{1,3}) ?[, ] ?(\d{1,3})(?: ?[,/] ?([\d.]{1,8}%?))? ?\)$/,
  );
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([r, g, b].some((c) => Number.isNaN(c) || c > 255)) return null;
  const alphaRaw = m[4];
  let alpha = 1;
  if (alphaRaw !== undefined) {
    alpha = alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
  }
  if (Number.isNaN(alpha) || alpha <= 0.02) return null; // effectively invisible
  const hex = (c: number): string => c.toString(16).padStart(2, "0");
  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return alpha >= 0.99 ? base : `${base}${hex(Math.round(alpha * 255))}`;
}

/** count desc, then value asc — full determinism regardless of input order. */
function sortFrequencies(map: ReadonlyMap<string, number>): TokenFrequency[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function bump(map: Map<string, number>, value: string | null | undefined): void {
  if (!value) return;
  map.set(value, (map.get(value) ?? 0) + 1);
}

/**
 * issue #32 — for a spacing metric, which computed properties (in
 * priority order) carry it. First non-zero px length wins; a metric
 * whose props are all zero/absent contributes NO spacing token (loud
 * skip, never a default — CLAUDE.md §2).
 */
const SPACING_METRICS = {
  // Vertical section rhythm: section padding, or its flex/grid gap.
  section: ["paddingTop", "paddingBottom", "gap"],
  // Page gutter: horizontal container padding.
  container: ["paddingLeft", "paddingRight"],
  // Card inner padding.
  card: ["paddingTop", "paddingLeft"],
  // Button inner padding.
  button: ["paddingTop", "paddingLeft"],
} as const satisfies Record<string, readonly string[]>;

/** A single positive CSS px length as getComputedStyle resolves it. */
const PX_LENGTH_RE = /^\d+(\.\d+)?px$/;

/**
 * First non-zero positive px length among `props` (priority order), or
 * null when none qualifies. Zero and non-length values are skipped so a
 * metric only contributes when the source actually painted spacing.
 */
function pickLength(
  styles: Readonly<Record<string, string>>,
  props: readonly string[],
): string | null {
  for (const p of props) {
    const raw = (styles[p] ?? "").trim();
    if (raw && raw !== "0px" && PX_LENGTH_RE.test(raw)) return raw;
  }
  return null;
}

/** Which sample role feeds each spacing metric. */
const SPACING_SOURCE_ROLE: Record<keyof typeof SPACING_METRICS, SampleRole> = {
  section: "section",
  container: "container",
  card: "card",
  button: "button",
};

/** Properties worth keeping in the per-role summary, per role kind. */
const ROLE_PROPS = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "borderRadius",
  "boxShadow",
] as const;

/**
 * PURE: raw element samples in → compact token JSON out. Deterministic
 * for identical input (fixed caps, stable sort), independent of sample
 * order except for the roles record, which keeps the FIRST sample per
 * role (the collection script emits the most prominent one first).
 */
export function deriveDesignTokens(samples: readonly ElementStyleSample[]): PageDesignTokens {
  const palette = new Map<string, number>();
  const backgrounds = new Map<string, number>();
  const fontFamilies = new Map<string, number>();
  const fontSizes = new Map<string, number>();
  const fontWeights = new Map<string, number>();
  const radii = new Map<string, number>();
  const shadows = new Map<string, number>();
  const roles: Record<string, Record<string, string>> = {};
  // issue #32 — per-metric frequency of the measured spacing length.
  const spacingFreq: Record<keyof typeof SPACING_METRICS, Map<string, number>> = {
    section: new Map(),
    container: new Map(),
    card: new Map(),
    button: new Map(),
  };

  for (const s of samples) {
    for (const metric of Object.keys(SPACING_METRICS) as (keyof typeof SPACING_METRICS)[]) {
      if (s.role !== SPACING_SOURCE_ROLE[metric]) continue;
      bump(spacingFreq[metric], pickLength(s.styles, SPACING_METRICS[metric]));
    }
    const text = normalizeColor(s.styles.color ?? "");
    const bg = normalizeColor(s.styles.backgroundColor ?? "");
    bump(palette, text);
    bump(palette, bg);
    bump(backgrounds, bg);
    bump(fontFamilies, (s.styles.fontFamily ?? "").trim() || null);
    bump(fontSizes, (s.styles.fontSize ?? "").trim() || null);
    bump(fontWeights, (s.styles.fontWeight ?? "").trim() || null);
    const radius = (s.styles.borderRadius ?? "").trim();
    if (radius && radius !== "0px") bump(radii, radius);
    const shadow = (s.styles.boxShadow ?? "").trim();
    if (shadow && shadow !== "none") bump(shadows, shadow);

    if (!roles[s.role]) {
      const kept: Record<string, string> = {};
      for (const prop of ROLE_PROPS) {
        const raw = (s.styles[prop] ?? "").trim();
        if (!raw) continue;
        // Colors land normalised so downstream consumers (compose, the
        // AI) never re-parse rgb() strings.
        if (prop === "color" || prop === "backgroundColor") {
          const norm = normalizeColor(raw);
          if (norm) kept[prop] = norm;
        } else if (raw !== "none" && raw !== "0px") {
          kept[prop] = raw;
        }
      }
      roles[s.role] = kept;
    }
  }

  return {
    palette: sortFrequencies(palette).slice(0, CAPS.palette),
    backgrounds: sortFrequencies(backgrounds).slice(0, CAPS.backgrounds),
    fontFamilies: sortFrequencies(fontFamilies).slice(0, CAPS.fontFamilies),
    fontSizes: sortFrequencies(fontSizes).slice(0, CAPS.fontSizes),
    fontWeights: sortFrequencies(fontWeights).slice(0, CAPS.fontWeights),
    radii: sortFrequencies(radii).slice(0, CAPS.radii),
    shadows: sortFrequencies(shadows).slice(0, CAPS.shadows),
    spacing: buildSpacingScale(spacingFreq),
    roles,
  };
}

/**
 * issue #32 — collapse per-metric frequency maps into the compact
 * spacing scale: each metric keeps its most frequent length (count
 * desc, then value asc for determinism). Metrics with no non-zero
 * sample are omitted — no default is invented.
 */
function buildSpacingScale(
  freq: Record<keyof typeof SPACING_METRICS, ReadonlyMap<string, number>>,
): Record<string, string> {
  const spacing: Record<string, string> = {};
  for (const metric of Object.keys(SPACING_METRICS) as (keyof typeof SPACING_METRICS)[]) {
    const top = sortFrequencies(freq[metric])[0];
    if (top) spacing[metric] = top.value;
  }
  return spacing;
}

/**
 * PURE: fold per-page token JSONs into ONE site-level summary.
 * Frequency lists merge by summing counts; role properties resolve by
 * majority vote (ties break lexicographically for determinism).
 */
export function aggregateSiteDesignTokens(pages: readonly PageDesignTokens[]): SiteDesignTokens {
  const mergeFreq = (
    pick: (p: PageDesignTokens) => readonly TokenFrequency[],
    cap: number,
  ): TokenFrequency[] => {
    const map = new Map<string, number>();
    for (const p of pages) {
      for (const f of pick(p)) map.set(f.value, (map.get(f.value) ?? 0) + f.count);
    }
    return sortFrequencies(map).slice(0, cap);
  };

  // role → prop → value → votes (one vote per page).
  const roleVotes = new Map<string, Map<string, Map<string, number>>>();
  for (const p of pages) {
    for (const [role, props] of Object.entries(p.roles)) {
      const propMap = roleVotes.get(role) ?? new Map<string, Map<string, number>>();
      roleVotes.set(role, propMap);
      for (const [prop, value] of Object.entries(props)) {
        const valueMap = propMap.get(prop) ?? new Map<string, number>();
        propMap.set(prop, valueMap);
        valueMap.set(value, (valueMap.get(value) ?? 0) + 1);
      }
    }
  }
  const roles: Record<string, Record<string, string>> = {};
  for (const [role, propMap] of [...roleVotes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const resolved: Record<string, string> = {};
    for (const [prop, valueMap] of [...propMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const winner = sortFrequencies(valueMap)[0];
      if (winner) resolved[prop] = winner.value;
    }
    roles[role] = resolved;
  }

  // issue #32 — spacing scale resolves per metric by majority vote (one
  // vote per page that measured that metric). An unmeasured metric stays
  // absent site-wide.
  const spacingVotes = new Map<string, Map<string, number>>();
  for (const p of pages) {
    for (const [metric, value] of Object.entries(p.spacing)) {
      const valueMap = spacingVotes.get(metric) ?? new Map<string, number>();
      spacingVotes.set(metric, valueMap);
      valueMap.set(value, (valueMap.get(value) ?? 0) + 1);
    }
  }
  const spacing: Record<string, string> = {};
  for (const [metric, valueMap] of [...spacingVotes.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const winner = sortFrequencies(valueMap)[0];
    if (winner) spacing[metric] = winner.value;
  }

  return {
    palette: mergeFreq((p) => p.palette, CAPS.palette),
    backgrounds: mergeFreq((p) => p.backgrounds, CAPS.backgrounds),
    fontFamilies: mergeFreq((p) => p.fontFamilies, CAPS.fontFamilies),
    fontSizes: mergeFreq((p) => p.fontSizes, CAPS.fontSizes),
    fontWeights: mergeFreq((p) => p.fontWeights, CAPS.fontWeights),
    radii: mergeFreq((p) => p.radii, CAPS.radii),
    shadows: mergeFreq((p) => p.shadows, CAPS.shadows),
    spacing,
    roles,
    pageCount: pages.length,
  };
}

/** A computed length/number the DTCG dimension schema accepts as-is
 *  (`16px`, `1.5rem`, unitless `1.5`, bare `0`). Excludes `normal`,
 *  `auto`, etc. so a non-length never reaches the theme validator. */
const DIMENSION_VALUE_RE = /^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|vmin|vmax|pt|pc|ch|ex)?$/;

/**
 * issue #32 — build a DTCG typography composite from a role's sampled
 * props. fontFamily passes through; fontSize / lineHeight are kept only
 * when they are real CSS lengths (computed `line-height` is often
 * `normal`, which the theme's `dimension` schema rejects — skip it
 * loudly rather than feed junk that aborts the whole compose);
 * fontWeight is coerced to the number the composite schema wants
 * (getComputedStyle yields `"700"`, but `fontWeightValue` accepts a
 * number or a keyword, never a numeric string). Returns null when no
 * sub-field qualified, so an unsampled role emits no token.
 */
function typographyComposite(
  props: Readonly<Record<string, string>>,
): Record<string, string | number> | null {
  const composite: Record<string, string | number> = {};
  const family = (props.fontFamily ?? "").trim();
  if (family) composite.fontFamily = family;
  const size = (props.fontSize ?? "").trim();
  if (size && DIMENSION_VALUE_RE.test(size)) composite.fontSize = size;
  const lineHeight = (props.lineHeight ?? "").trim();
  if (lineHeight && DIMENSION_VALUE_RE.test(lineHeight)) composite.lineHeight = lineHeight;
  const weight = (props.fontWeight ?? "").trim();
  if (/^\d+$/.test(weight)) composite.fontWeight = Number(weight);
  else if (weight === "normal" || weight === "bold") composite.fontWeight = weight;
  return Object.keys(composite).length > 0 ? composite : null;
}

/**
 * PURE: site-level summary → flat `{token, value, scope}` tuples in the
 * shape `imports.compose_from_run` aggregates (and
 * `prepareLegacyAggregatedToken` canonicalises). Only emits tokens the
 * theme layer can actually store; sampled values overwrite same-named
 * extractor tokens at the compose merge because computed styles are
 * ground truth.
 *
 * Typography lands as DTCG composites (`typography.body` /
 * `typography.heading`) carrying the measured type scale — family +
 * size + weight + line-height — so the rebuild uses the source's actual
 * scale instead of the AI eyeballing it. These are the roles the theme
 * renderer + editors already expect (`--font-body`, `--text-heading`,
 * `--font-weight-heading`, `--leading-*`); the body font moves from the
 * old `typography.family` slot onto `typography.body` where the renderer
 * reads it. `space-*` tuples carry the measured spacing rhythm.
 */
export function flattenSiteDesignTokens(
  site: SiteDesignTokens,
): Array<{ token: string; value: string; scope: string }> {
  const out: Array<{ token: string; value: string; scope: string }> = [];
  const role = (name: string): Readonly<Record<string, string>> => site.roles[name] ?? {};
  const push = (token: string, scope: string, value: string | undefined): void => {
    if (value) out.push({ token, value, scope });
  };
  push("color-background", "color", role("body").backgroundColor);
  push("color-text", "color", role("body").color);
  push("color-heading", "color", role("h1").color);
  push("color-link", "color", role("a").color);
  push("color-primary", "color", role("button").backgroundColor);
  push("color-primary-contrast", "color", role("button").color);

  // Type scale — one composite per role. Body family comes from `body`,
  // its size/line-height from the representative paragraph.
  const body = typographyComposite({
    fontFamily: role("body").fontFamily ?? "",
    fontSize: role("p").fontSize ?? "",
    lineHeight: role("p").lineHeight ?? "",
  });
  if (body)
    out.push({ token: "typography-body", value: JSON.stringify(body), scope: "typography" });
  const heading = typographyComposite(role("h1"));
  if (heading)
    out.push({ token: "typography-heading", value: JSON.stringify(heading), scope: "typography" });

  push("radius-base", "radius", role("button").borderRadius);

  // Spacing scale — measured rhythm. Emitted after type so the ordering
  // stays stable + easy to assert.
  for (const metric of ["section", "container", "card", "button"]) {
    push(`space-${metric}`, "space", site.spacing[metric]);
  }
  return out;
}
