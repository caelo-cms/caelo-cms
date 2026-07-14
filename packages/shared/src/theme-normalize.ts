// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — Loose-name → canonical-DTCG-path normalizer for theme
 * tokens (#45, follow-up comment §1).
 *
 * The AI naturally sends prose-shaped inputs ("set primary color to
 * #ff6600", "use Inter for headings") — translating that into
 * `{ primaryColor: "#ff6600", fontHeading: "Inter" }`. The canonical
 * DTCG path is `color.primary.$value` / `typography.heading.fontFamily`.
 * The server normalizes loose names to canonical paths so the AI never
 * has to know the canonical surface up front.
 *
 * Coverage (from the issue's normalization table):
 *
 *   primaryColor, colorPrimary, primary + color value     → color.primary
 *   fontHeading, headingFont, heading-font               → typography.heading.fontFamily
 *   spacingLg, spacing-lg, lg + CSS length               → spacing.lg
 *   radiusMd, borderRadius, rounded-md                   → radius.md
 *   shadowSm, shadow-sm, boxShadow                       → shadow.sm
 *   gradient, heroGradient, gradientHero, gradient.hero  → gradient.hero
 *   color.primary.$value (canonical DTCG path)           → passthrough
 *   --color-primary (CSS-var)                            → color.primary
 *   "{color.brand.primary}" (DTCG alias)                 → passthrough at value layer
 *
 * Ambiguity (no value-shape signal) returns `UnknownTokenName` with
 * did-you-mean suggestions, per CLAUDE.md §11 "Failure surfaces are
 * AI-actionable".
 */

import { InvalidColorValue, TokenCategoryMismatch, UnknownTokenName } from "./themes-errors.js";

export type CanonicalPath = string;

export interface NormalizeResult {
  /**
   * Map from canonical DTCG path (e.g. "color.primary") to the value
   * the caller supplied. The ops layer rebuilds the DTCG leaf
   * (`{$value: <value>, $type: <inferred>}`) from this.
   */
  readonly set: Record<CanonicalPath, unknown>;
  /**
   * Inferred `$type` per canonical path. The renderer also knows the
   * category from the path prefix, but the ops layer uses this to set
   * `$type` on the stored token.
   */
  readonly types: Record<
    CanonicalPath,
    "color" | "dimension" | "typography" | "shadow" | "duration" | "cubicBezier" | "gradient"
  >;
  /** Echo-back list for the AI tool's result content. */
  readonly canonicalPaths: readonly CanonicalPath[];
}

const COLOR_VALUE_REGEX =
  /^(#[0-9a-fA-F]{3,8}|(oklch|rgb|rgba|hsl|hsla|lab|lch|color|hwb)\(.+\)|transparent|currentColor)$/;
const CSS_LENGTH_REGEX = /^-?\d+(\.\d+)?(rem|em|px|%|vh|vw|vmin|vmax|pt|pc|ch|ex)?$/;
const DURATION_REGEX = /^\d+(\.\d+)?(ms|s)$/;
const ALIAS_REGEX = /^\{[a-zA-Z0-9_.-]+\}$/;
const SHADOW_VALUE_REGEX = /^(-?\d+(\.\d+)?(rem|em|px|%)? *){2,5}(.+)?$/;
// A CSS `*-gradient(...)` value. Mirrors (loosely) the stricter Zod
// `gradientValueString` in themes.ts — the normalizer only needs to
// RECOGNISE gradient strings to route them to the gradient category and
// infer `$type: "gradient"`; the document validator enforces the exact
// safe shape (no url(), no `;<>{}` breakout) downstream.
const GRADIENT_VALUE_REGEX = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(.+\)$/i;

/**
 * The canonical "well-known" tokens the AI is most likely to mean when
 * it sends a bare or category-prefixed name. Used both as the
 * normalization target AND as the suggestion pool when an input is
 * ambiguous.
 */
const KNOWN_CANONICAL_PATHS: readonly CanonicalPath[] = [
  // colors (shadcn-inspired semantic set)
  "color.background",
  "color.foreground",
  "color.primary",
  "color.primary-foreground",
  "color.secondary",
  "color.secondary-foreground",
  "color.accent",
  "color.accent-foreground",
  "color.muted",
  "color.muted-foreground",
  "color.card",
  "color.card-foreground",
  "color.border",
  "color.ring",
  "color.destructive",
  "color.destructive-foreground",
  "color.warning",
  "color.success",
  // typography (heading + body + display, each with fontFamily as the
  // primary loose-name target; fontSize / fontWeight are addressable
  // via direct DTCG paths)
  "typography.heading.fontFamily",
  "typography.body.fontFamily",
  "typography.display.fontFamily",
  "typography.mono.fontFamily",
  // spacing scale (Tailwind-shaped)
  "spacing.xs",
  "spacing.sm",
  "spacing.md",
  "spacing.lg",
  "spacing.xl",
  "spacing.2xl",
  // radius
  "radius.sm",
  "radius.md",
  "radius.lg",
  "radius.full",
  // shadow
  "shadow.sm",
  "shadow.md",
  "shadow.lg",
  "shadow.xl",
  // gradient (issue #153 — CSS gradient strings emitted as
  // `--gradient-<name>`; `hero` + `subtle` are the seeded slots)
  "gradient.hero",
  "gradient.subtle",
];

interface CategoryDef {
  readonly category:
    | "color"
    | "typography"
    | "spacing"
    | "radius"
    | "shadow"
    | "duration"
    | "gradient";
  /** Name-shape heuristics that hint at this category. */
  readonly nameHints: readonly RegExp[];
  /** Type that gets stored at the leaf's `$type` field. */
  readonly inferredType: "color" | "dimension" | "typography" | "shadow" | "duration" | "gradient";
  /** Builds the canonical DTCG path from the basename. */
  readonly buildPath: (basename: string) => CanonicalPath;
}

const CATEGORIES: readonly CategoryDef[] = [
  {
    category: "color",
    nameHints: [
      /color/i,
      /^bg$/i,
      /background/i,
      /foreground/i,
      /destructive/i,
      /primary$/i,
      /secondary$/i,
      /accent$/i,
      /muted$/i,
      /ring$/i,
      /border$/i,
    ],
    inferredType: "color",
    buildPath: (basename) => `color.${basename}`,
  },
  {
    category: "typography",
    nameHints: [/font/i, /typography/i, /heading/i, /body/i, /display/i, /mono/i],
    inferredType: "typography",
    // v0.11.0 fix (#45 review thread): loose typography names target
    // the composite ROOT (`typography.<name>`) — themeTypographyComposite
    // Zod requires `$value` to be an object. The value gets wrapped as
    // `{fontFamily: <input>}` in normalizeTokens (see compositeWrap
    // below). The original sub-path shape (`typography.X.fontFamily`)
    // produced documents Zod rejected.
    buildPath: (basename) => `typography.${basename}`,
  },
  {
    category: "spacing",
    nameHints: [/^space/i, /^spacing/i, /^gap/i, /^padding/i, /^margin/i],
    inferredType: "dimension",
    buildPath: (basename) => `spacing.${basename}`,
  },
  {
    category: "radius",
    nameHints: [/radius/i, /rounded/i, /corner/i, /^border-?radius$/i],
    inferredType: "dimension",
    buildPath: (basename) => `radius.${basename}`,
  },
  {
    category: "shadow",
    nameHints: [/shadow/i, /elevation/i, /^box-?shadow$/i],
    inferredType: "shadow",
    buildPath: (basename) => `shadow.${basename}`,
  },
  {
    // issue #153 — gradient tokens. Loose names (`gradient`,
    // `heroGradient`, `gradientHero`) + the direct DTCG path
    // (`gradient.hero`) all land in `gradient.<name>` with
    // `$type: "gradient"`. Without this category the normalizer threw
    // `UnknownTokenName` on every loose gradient name (the #1 red-error
    // class in migration chat).
    category: "gradient",
    nameHints: [/gradient/i],
    inferredType: "gradient",
    buildPath: (basename) => `gradient.${basename}`,
  },
  {
    category: "duration",
    nameHints: [/duration/i, /timing/i],
    inferredType: "duration",
    buildPath: (basename) => `duration.${basename}`,
  },
];

const DEFAULT_TIER = "sm"; // shadowSm / radiusMd default

/**
 * Normalize a record of loose-name → value pairs into canonical DTCG
 * paths. Throws `UnknownTokenName` on the first ambiguous entry so the
 * AI gets a single concrete next-step rather than a wall of partial
 * results.
 */
export function normalizeTokens(input: Record<string, unknown>): NormalizeResult {
  const set: Record<CanonicalPath, unknown> = {};
  const types: Record<CanonicalPath, NormalizeResult["types"][string]> = {};
  const paths: CanonicalPath[] = [];

  for (const [rawName, rawValueIn] of Object.entries(input)) {
    // issue #242 (F11) — tolerate the two encodings the AI actually
    // sends for composite values, then validate content strictly:
    //  1. a JSON-encoded object string → parse it;
    //  2. the full DTCG envelope `{$type?, $value}` → unwrap to $value
    //     (storing the envelope verbatim would nest `$value.$value`
    //     and bounce off the document schema).
    let rawValue = rawValueIn;
    if (typeof rawValue === "string" && rawValue.trim().startsWith("{")) {
      try {
        rawValue = JSON.parse(rawValue) as unknown;
      } catch {
        // Not JSON after all — keep the literal string.
      }
    }
    if (
      rawValue !== null &&
      typeof rawValue === "object" &&
      !Array.isArray(rawValue) &&
      "$value" in (rawValue as Record<string, unknown>)
    ) {
      rawValue = (rawValue as Record<string, unknown>).$value;
    }
    const resolved = resolveOne(rawName, rawValue);
    // v0.11.0 fix (#45 review thread on theme-normalize.ts:149) —
    // typography is a composite; `$value` MUST be an object per the
    // Zod schema. When the loose input (or a direct `typography.X.<sub>`
    // DTCG path, or a `--font-X` / `--text-X` CSS-var) implied a single
    // sub-field, wrap the scalar value as `{[subField]: value}` so the
    // resulting document validates. applyDtcgWrites merges this into
    // any existing typography composite at the path so partial updates
    // don't erase sibling sub-fields.
    let storedValue: unknown = rawValue;
    if (resolved.compositeWrap && typeof rawValue === "string" && !ALIAS_REGEX.test(rawValue)) {
      storedValue = { [resolved.compositeWrap]: rawValue };
    } else if (
      resolved.inferredType === "gradient" &&
      typeof rawValue === "object" &&
      rawValue !== null &&
      !Array.isArray(rawValue)
    ) {
      // issue #153 — the AI sometimes sends a structured gradient
      // (`{type, angle, stops}`) instead of the CSS string the DTCG
      // gradient token stores. Fold it into the canonical
      // `linear-gradient(...)` form so the document validates and the
      // renderer emits a real `--gradient-<name>`. Unrecognised shapes
      // pass through untouched so the document validator produces the
      // actionable "gradient must be a CSS *-gradient(...) value" error
      // rather than us silently inventing a gradient (CLAUDE.md §2).
      storedValue = gradientObjectToCss(rawValue as Record<string, unknown>) ?? rawValue;
    }
    set[resolved.path] = storedValue;
    types[resolved.path] = resolved.inferredType;
    paths.push(resolved.path);
  }

  return { set, types, canonicalPaths: paths };
}

interface ResolvedToken {
  readonly path: CanonicalPath;
  readonly inferredType: NormalizeResult["types"][string];
  /**
   * When set, normalizeTokens wraps the raw value as
   * `{[compositeWrap]: rawValue}` so the resulting leaf matches the
   * typography (or future) composite `$value` shape. Unset for flat
   * categories (color / dimension / shadow / duration / cubicBezier).
   */
  readonly compositeWrap?: string;
}

function resolveOne(rawName: string, rawValue: unknown): ResolvedToken {
  // 1. Direct canonical DTCG paths: pass through unchanged. Typography
  //    sub-paths (`typography.X.fontFamily` / `.fontSize` / …) collapse
  //    onto the composite root so the leaf carries `$value: {sub: val}`.
  if (/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+(\.\$value)?$/i.test(rawName)) {
    const path = rawName.replace(/\.\$value$/, "");
    const parts = path.split(".");
    const category = parts[0] ?? "";
    if (
      category === "typography" &&
      parts.length === 3 &&
      isTypographyCompositeSubField(parts[2])
    ) {
      return {
        path: `${parts[0]}.${parts[1]}`,
        inferredType: "typography",
        compositeWrap: parts[2],
      };
    }
    validateValueShape(category, rawValue, path);
    return { path, inferredType: inferTypeFromPath(path, rawValue) };
  }

  // 2. CSS-var form: `--color-primary` → `color.primary`.
  if (rawName.startsWith("--")) {
    const stripped = rawName.slice(2);
    const firstHyphen = stripped.indexOf("-");
    if (firstHyphen > 0) {
      const category = stripped.slice(0, firstHyphen);
      const rest = stripped.slice(firstHyphen + 1);
      // Tailwind 4 typography split (--font + --text) maps onto the
      // composite root with the right sub-field set; the value gets
      // wrapped into `{fontFamily}` / `{fontSize}` by normalizeTokens
      // so the leaf matches themeTypographyComposite.
      if (category === "font") {
        return {
          path: `typography.${rest}`,
          inferredType: "typography",
          compositeWrap: "fontFamily",
        };
      }
      if (category === "text") {
        validateValueShape("spacing", rawValue, `typography.${rest}`);
        return {
          path: `typography.${rest}`,
          inferredType: "typography",
          compositeWrap: "fontSize",
        };
      }
      const path = `${category}.${rest}`;
      validateValueShape(category, rawValue, path);
      return { path, inferredType: inferTypeFromPath(path, rawValue) };
    }
  }

  // 3. Name-shape category hint.
  const matched: CategoryDef[] = [];
  for (const cat of CATEGORIES) {
    if (cat.nameHints.some((re) => re.test(rawName))) matched.push(cat);
  }

  // 4. Value-shape signal — disambiguates when the name is bare or
  // matched multiple categories.
  const valueCategory = sniffCategoryFromValue(rawValue);

  let chosen: CategoryDef | undefined;
  if (matched.length === 1) {
    chosen = matched[0];
  } else if (matched.length > 1) {
    // Prefer the category whose inferred type matches the value shape.
    chosen = matched.find((m) => m.inferredType === valueCategory) ?? matched[0];
  } else if (valueCategory) {
    // Bare name but value hints — pick category by value.
    chosen = CATEGORIES.find((c) => c.inferredType === valueCategory);
  }

  if (!chosen) {
    throw new UnknownTokenName(rawName, didYouMean(rawName));
  }

  // 5. Extract basename: strip category prefix + camel/kebab.
  const basename = extractBasename(rawName, chosen.category);
  const path = basename
    ? chosen.buildPath(basename)
    : // Bare category word ("color" / "shadow") — pick the default tier
      // (`primary` for color, `sm` for shadow/radius, etc.).
      chosen.buildPath(defaultTier(chosen.category));
  validateValueShape(chosen.category, rawValue, path);
  // Typography is a composite — loose names imply a single sub-field
  // (fontFamily by convention). The wrap happens in normalizeTokens.
  if (chosen.category === "typography") {
    return { path, inferredType: chosen.inferredType, compositeWrap: "fontFamily" };
  }
  return { path, inferredType: chosen.inferredType };
}

/**
 * Sub-field keys recognised by `themeTypographyComposite`. Used to
 * detect direct DTCG sub-paths like `typography.heading.fontFamily`
 * and collapse them onto the composite root with a wrapped value.
 */
function isTypographyCompositeSubField(segment: string | undefined): segment is string {
  return (
    segment === "fontFamily" ||
    segment === "fontSize" ||
    segment === "fontWeight" ||
    segment === "lineHeight" ||
    segment === "letterSpacing"
  );
}

/**
 * v0.11.0 (#45 AC #7) — fail-fast value-shape validation for the
 * AI-actionable error surface. Catches:
 *
 *   - color slot + string value that isn't a valid CSS color
 *     → InvalidColorValue (carries supportedFormats list).
 *   - any slot + value whose sniffed category disagrees with the
 *     resolved slot's category → TokenCategoryMismatch (carries
 *     expected vs got).
 *
 * Aliases (`{color.primary}`) bypass — they're resolved at render
 * time and may legitimately point at a value of any shape. Non-string
 * values (numbers, composite objects) also bypass because the AI
 * passes those only on direct DTCG paths where the Zod composite
 * schema validates the shape downstream.
 *
 * Typography sub-paths (`typography.<name>.fontFamily`) skip the
 * check because fontFamily accepts free-form strings.
 */
function validateValueShape(category: string, value: unknown, canonicalPath: string): void {
  if (typeof value !== "string") return;
  if (ALIAS_REGEX.test(value)) return;

  if (category === "color") {
    if (COLOR_VALUE_REGEX.test(value)) return;
    const sniffed = sniffCategoryFromValue(value);
    if (sniffed && sniffed !== "color") {
      throw new TokenCategoryMismatch(canonicalPath, "color", sniffed);
    }
    throw new InvalidColorValue(value);
  }

  if (category === "spacing" || category === "radius" || category === "breakpoint") {
    const sniffed = sniffCategoryFromValue(value);
    if (sniffed && sniffed !== "dimension") {
      throw new TokenCategoryMismatch(canonicalPath, "dimension", sniffed);
    }
    return;
  }

  if (category === "duration") {
    const sniffed = sniffCategoryFromValue(value);
    if (sniffed && sniffed !== "duration") {
      throw new TokenCategoryMismatch(canonicalPath, "duration", sniffed);
    }
    return;
  }

  if (category === "gradient") {
    if (GRADIENT_VALUE_REGEX.test(value)) return;
    const sniffed = sniffCategoryFromValue(value);
    if (sniffed && sniffed !== "gradient") {
      // e.g. a flat color string sent to `gradient.hero` — name the
      // mismatch instead of letting Zod reject with a vaguer message.
      throw new TokenCategoryMismatch(canonicalPath, "gradient", sniffed);
    }
    // Not a recognised gradient and not clearly another category — defer
    // to the document validator's precise "gradient must be a CSS
    // *-gradient(...) value" message rather than guessing here.
    return;
  }

  // shadow / typography composites + unknown categories: caller's
  // responsibility to pass a structurally-correct value; Zod catches
  // the rest at validateThemeTokens time.
}

function inferTypeFromPath(path: string, value: unknown): NormalizeResult["types"][string] {
  const head = path.split(".")[0] ?? "";
  switch (head) {
    case "color":
      return "color";
    case "typography":
      // Composite vs sub-field. A `.fontFamily` / `.fontSize` etc.
      // suffix lives inside the composite — type stays "typography"
      // for top-level + "dimension" / "color" / etc. for sub-fields
      // depending on which slot. Caller stores at the composite root
      // anyway, so this stays "typography" for any typography.* path.
      return "typography";
    case "spacing":
    case "radius":
    case "breakpoint":
      return "dimension";
    case "shadow":
      return "shadow";
    case "gradient":
      // issue #153 — MUST return "gradient" (not the sniffed value
      // category). The gradient token's `$type` is `z.literal("gradient")`;
      // before this case, `gradient.hero` fell through to `default`, the
      // gradient string sniffed as no known category → "dimension", and
      // the stamped `$type: "dimension"` bounced off the document
      // validator ("gradient token invalid: expected \"gradient\"").
      return "gradient";
    case "duration":
      return "duration";
    case "ease":
      return "cubicBezier";
    default: {
      const sniffed = sniffCategoryFromValue(value);
      return sniffed ?? "dimension";
    }
  }
}

function sniffCategoryFromValue(value: unknown): NormalizeResult["types"][string] | undefined {
  if (typeof value !== "string") return undefined;
  if (ALIAS_REGEX.test(value)) return undefined; // alias has no value shape
  // Gradient before color: a `linear-gradient(...)` string could loosely
  // read as a `color(...)`-shaped function otherwise.
  if (GRADIENT_VALUE_REGEX.test(value)) return "gradient";
  if (COLOR_VALUE_REGEX.test(value)) return "color";
  if (DURATION_REGEX.test(value)) return "duration";
  if (SHADOW_VALUE_REGEX.test(value) && /\s/.test(value)) return "shadow";
  if (CSS_LENGTH_REGEX.test(value)) return "dimension";
  return undefined;
}

/**
 * Pull the meaningful basename out of a loose name. `primaryColor` /
 * `colorPrimary` / `primary-color` all reduce to `primary`. Plural
 * forms (`spacingLg`) lose the category prefix to leave the tier (`lg`).
 *
 * Returns null when the input IS the category word alone.
 */
function extractBasename(rawName: string, category: string): string | null {
  // Lowercase camelCase → kebab-case for uniform tokenisation.
  const kebab = rawName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const parts = kebab.split(/[-_]+/);

  // Filter out category aliases (font / typography / heading-related
  // names) AND the literal category itself.
  const aliasesFor: Record<string, readonly string[]> = {
    color: ["color"],
    typography: ["font", "typography"],
    spacing: ["space", "spacing", "gap", "padding", "margin"],
    radius: ["radius", "rounded", "border", "borderradius", "border-radius", "corner"],
    shadow: ["shadow", "box", "boxshadow", "box-shadow", "elevation"],
    duration: ["duration", "timing"],
    gradient: ["gradient"],
  };
  const aliases = new Set(aliasesFor[category] ?? [category]);
  const meaningful = parts.filter((p) => p.length > 0 && !aliases.has(p));
  if (meaningful.length === 0) return null;
  return meaningful.join("-");
}

function defaultTier(category: string): string {
  switch (category) {
    case "color":
      return "primary";
    case "typography":
      return "body";
    case "spacing":
      return "md";
    case "radius":
      return "md";
    case "shadow":
      return DEFAULT_TIER;
    case "duration":
      return "fast";
    case "gradient":
      // The seeded default theme ships `gradient.hero` + `gradient.subtle`;
      // a bare `gradient` almost always means the primary/hero surface.
      return "hero";
    default:
      return "default";
  }
}

/**
 * issue #153 — best-effort structured-gradient → CSS-string converter.
 *
 * The DTCG gradient token stores a CSS `*-gradient(...)` string (see
 * `themeGradientToken` in themes.ts). When the AI sends a structured
 * shape instead, fold the RECOGNISED subset into that string:
 *
 *   `{ type?: "linear"|"radial"|"conic", angle?: string|number,
 *      direction?: string, stops: Array<string | {color, position?}> }`
 *
 *   → `linear-gradient(135deg, #4f46e5, #7c3aed 100%)`
 *
 * Returns `undefined` (caller keeps the raw value so the document
 * validator emits its precise error) when the shape carries no usable
 * stops — we never fabricate a gradient from nothing (CLAUDE.md §2).
 */
function gradientObjectToCss(obj: Record<string, unknown>): string | undefined {
  const rawStops = obj.stops;
  if (!Array.isArray(rawStops) || rawStops.length < 2) return undefined;

  const stops: string[] = [];
  for (const s of rawStops) {
    if (typeof s === "string" && s.trim().length > 0) {
      stops.push(s.trim());
      continue;
    }
    if (s !== null && typeof s === "object" && !Array.isArray(s)) {
      const stop = s as Record<string, unknown>;
      const color = typeof stop.color === "string" ? stop.color.trim() : undefined;
      if (!color) return undefined;
      const pos =
        typeof stop.position === "string"
          ? stop.position.trim()
          : typeof stop.position === "number"
            ? `${stop.position}%`
            : undefined;
      stops.push(pos ? `${color} ${pos}` : color);
      continue;
    }
    return undefined; // unrecognised stop entry — don't guess
  }

  const type =
    obj.type === "radial" || obj.type === "conic" || obj.type === "linear" ? obj.type : "linear";

  // Leading orientation argument. Linear/conic accept an angle; radial
  // accepts a shape/extent hint via `direction`. Only linear gets a
  // default angle so a bare `{stops}` still reads as a diagonal sweep.
  let head = "";
  if (typeof obj.direction === "string" && obj.direction.trim().length > 0) {
    head = obj.direction.trim();
  } else if (obj.angle !== undefined && obj.angle !== null) {
    const a = obj.angle;
    head = typeof a === "number" ? `${a}deg` : String(a).trim();
  } else if (type === "linear") {
    head = "135deg";
  }

  const args = head ? `${head}, ${stops.join(", ")}` : stops.join(", ");
  return `${type}-gradient(${args})`;
}

/**
 * Closest-match suggestions for an unknown input. Cheap edit-distance
 * over the canonical-paths set — good enough that the AI gets a useful
 * "did you mean X?" without pulling a fuzzy-search dep.
 */
export function didYouMean(input: string): readonly string[] {
  const lower = input.toLowerCase();
  return KNOWN_CANONICAL_PATHS.map((p) => ({ path: p, score: similarity(lower, p.toLowerCase()) }))
    .filter((c) => c.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.path);
}

function similarity(a: string, b: string): number {
  const tokensA = new Set(tokenise(a));
  const tokensB = new Set(tokenise(b));
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const max = Math.max(tokensA.size, tokensB.size);
  return max === 0 ? 0 : hits / max;
}

function tokenise(s: string): string[] {
  return s.split(/[.\-_]/).filter((p) => p.length > 0);
}
