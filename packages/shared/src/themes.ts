// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — DTCG-aligned Zod schemas for the `themes` primitive (#45).
 *
 * Mirrors the W3C Design Tokens Format spec (2025.10 stable). Storage
 * is a single jsonb document grouped by category (color / typography /
 * spacing / radius / shadow / motion / breakpoint); each leaf carries a
 * `$value` (required), optional `$type`, optional `$description`, and
 * may use DTCG aliasing (`{group.token}`) to reference another token.
 *
 * Why DTCG: import/export from Figma / Tokens Studio / Style Dictionary
 * works out of the box. The admin UI doesn't show raw DTCG to
 * operators — it renders categorized panels — but the storage layer is
 * the lingua franca so design tooling round-trips cleanly.
 *
 * Caelo extensions over plain DTCG:
 * - Color tokens may carry `{ light, dark }` instead of a flat `$value`
 *   so the renderer can emit `:root { … }` + `:root.dark { … }` from
 *   one declaration.
 * - The `$extensions` namespace is tolerated (DTCG-spec-compatible)
 *   for tooling-specific metadata; we never inspect it server-side.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────

/** DTCG alias: `"{group.token}"` references another token by path. */
const aliasRegex = /^\{[a-zA-Z0-9_.-]+\}$/;

const aliasString = z.string().regex(aliasRegex, "DTCG alias must look like '{group.token}'");

/**
 * Color value: hex, oklch(...), rgb(...), hsl(...), or a named color.
 * Loose enough to accept anything a browser would render; strict
 * rejection lives at the loose-name normalizer where the AI can
 * recover with a structured error.
 */
const colorValueString = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(#[0-9a-fA-F]{3,8}|(oklch|rgb|rgba|hsl|hsla|lab|lch|color|hwb)\(.+\)|transparent|currentColor|[a-zA-Z]+)$/,
    "color value must be #hex, oklch(...), rgb(...), or a CSS named color",
  );

/** Dimension: a CSS length / percentage / numeric value. */
const dimensionValueString = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^-?\d+(\.\d+)?(rem|em|px|%|vh|vw|vmin|vmax|pt|pc|ch|ex|fr|deg|rad|turn|s|ms)?$|^auto$|^0$/,
    "dimension must be a CSS length / number / percentage",
  );

/** Font-weight: keyword or 1-1000 number. */
const fontWeightValue = z.union([
  z.number().int().min(1).max(1000),
  z.enum(["normal", "bold", "lighter", "bolder"]),
]);

const optionalDescription = z.string().max(500).optional();

// ────────────────────────────────────────────────────────────────────
// Per-type token shapes
// ────────────────────────────────────────────────────────────────────

const flatOrAliasColor = z.union([colorValueString, aliasString]);
const flatOrAliasDimension = z.union([dimensionValueString, aliasString]);

/**
 * Color token. Either a flat `$value` or a `{light, dark}` pair where
 * the renderer emits the light value in `:root { … }` and the dark
 * value in `:root.dark { … }`.
 */
export const themeColorToken = z
  .object({
    $value: z.union([
      flatOrAliasColor,
      z
        .object({
          light: flatOrAliasColor,
          dark: flatOrAliasColor,
        })
        .strict(),
    ]),
    $type: z.literal("color").optional(),
    $description: optionalDescription,
    $extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const themeDimensionToken = z
  .object({
    $value: flatOrAliasDimension,
    $type: z.literal("dimension").optional(),
    $description: optionalDescription,
    $extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Typography composite. Each sub-field is independently optional so
 * presets can ship a heading family without forcing a size, and vice
 * versa. The renderer emits one CSS variable per declared sub-field
 * (`--font-<name>`, `--text-<name>`, `--font-weight-<name>`, ...).
 */
export const themeTypographyComposite = z
  .object({
    $value: z.union([
      z
        .object({
          fontFamily: z.string().min(1).max(200).optional(),
          fontSize: dimensionValueString.optional(),
          fontWeight: fontWeightValue.optional(),
          lineHeight: z.union([z.number().positive(), dimensionValueString]).optional(),
          letterSpacing: dimensionValueString.optional(),
        })
        .strict(),
      aliasString,
    ]),
    $type: z.literal("typography").optional(),
    $description: optionalDescription,
    $extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Shadow composite (single or layered). */
const shadowValueObject = z
  .object({
    color: flatOrAliasColor,
    offsetX: dimensionValueString,
    offsetY: dimensionValueString,
    blur: dimensionValueString,
    spread: dimensionValueString.optional(),
    inset: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => {
      // Reject negative blur — physically meaningless, signals AI confusion.
      const m = /^-?(\d+(\.\d+)?)/.exec(v.blur);
      return !m || Number(m[0]) >= 0;
    },
    { message: "shadow blur must be ≥ 0", path: ["blur"] },
  );

export const themeShadowComposite = z
  .object({
    $value: z.union([shadowValueObject, z.array(shadowValueObject).min(1), aliasString]),
    $type: z.literal("shadow").optional(),
    $description: optionalDescription,
    $extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const themeDurationToken = z
  .object({
    $value: z.union([
      z.string().regex(/^\d+(\.\d+)?(ms|s)$/, "duration must end in ms or s"),
      aliasString,
    ]),
    $type: z.literal("duration").optional(),
    $description: optionalDescription,
    $extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const themeCubicBezierToken = z
  .object({
    $value: z.union([
      z
        .tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()])
        .describe("[x1, y1, x2, y2]"),
      aliasString,
    ]),
    $type: z.literal("cubicBezier").optional(),
    $description: optionalDescription,
    $extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Any token, in any category. The discriminator is the parent group
 * key (`color.*` → color, `spacing.*` → dimension, ...), but DTCG
 * doesn't strictly require `$type` so we accept any leaf carrying a
 * valid `$value`. Per-category strictness is enforced at the
 * normalizer + the renderer (which know which namespace the token
 * is being emitted into).
 */
const anyThemeToken = z.union([
  themeColorToken,
  themeDimensionToken,
  themeTypographyComposite,
  themeShadowComposite,
  themeDurationToken,
  themeCubicBezierToken,
]);

// ────────────────────────────────────────────────────────────────────
// Document shape
// ────────────────────────────────────────────────────────────────────

/**
 * One category group: a flat record of token-name → (token | sub-group
 * | `$`-prefixed metadata). DTCG allows arbitrary nesting; the
 * structural constraints (every non-`$` key must validate as a token
 * or nested group; `$description` must be a string) are enforced by
 * the `superRefine` walker at runtime — the TS type stays a permissive
 * `Record<string, unknown>` to match Zod's inferred type.
 *
 * Per DTCG spec, any group (including the document root) MAY carry
 * `$description` / `$extensions` metadata alongside its real children.
 * The four shipped presets do this at the root, and Figma / Tokens
 * Studio / Style Dictionary exports do it at every level.
 */
type TokenGroup = Record<string, unknown>;

const tokenGroupSchema: z.ZodType<TokenGroup> = z.lazy(() =>
  z.record(z.string(), z.unknown()).superRefine((obj, ctx) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("$")) {
        // DTCG group-level metadata. $description must be a string;
        // every other $-prefixed key is tooling extension data and
        // passes through unmodified (the spec leaves these open).
        if (k === "$description" && typeof v !== "string") {
          ctx.addIssue({
            code: "custom",
            path: [k],
            message: "$description must be a string",
          });
        }
        continue;
      }
      const sub = z.union([anyThemeToken, tokenGroupSchema]).safeParse(v);
      if (!sub.success) {
        for (const issue of sub.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: [k, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }),
);

/**
 * Top-level DTCG document. Known category keys at v0.11.0:
 *
 *   color, typography, spacing, radius, shadow, motion (duration +
 *   cubicBezier sub-groups), breakpoint.
 *
 * Unknown root keys are tolerated because DTCG explicitly leaves the
 * category vocabulary open — we don't want to reject a future
 * `effect` or `gradient` category that operators bring from Figma.
 * Root-level `$description` / `$extensions` are also tolerated (DTCG
 * presets routinely carry these — e.g. the shipped shadcn-default /
 * minimal / warm / playful JSONs all have `$description`).
 */
export const themeDocument: z.ZodType<TokenGroup> = tokenGroupSchema;

export type ThemeDocument = z.infer<typeof themeDocument>;
export type ThemeColorToken = z.infer<typeof themeColorToken>;
export type ThemeDimensionToken = z.infer<typeof themeDimensionToken>;
export type ThemeTypographyComposite = z.infer<typeof themeTypographyComposite>;
export type ThemeShadowComposite = z.infer<typeof themeShadowComposite>;
export type ThemeDurationToken = z.infer<typeof themeDurationToken>;
export type ThemeCubicBezierToken = z.infer<typeof themeCubicBezierToken>;
export type AnyThemeToken = z.infer<typeof anyThemeToken>;

/**
 * Theme aggregate — row + resolved asset URLs. The asset URLs are
 * derived server-side by joining `media`; the `{mediaId, url}` shape
 * lets the renderer / system-prompt emit either form without re-loading.
 */
export interface ThemeAssetRef {
  readonly mediaId: string;
  readonly url: string;
}

/**
 * v0.11.4 (issue #76 follow-up) — provenance of the current state.
 * `seed`: untouched starter palette (e.g. shadcn-default populated by
 * migration 0099). `ai`: most recent write was by an AI actor. `operator`:
 * most recent write was by a human actor. The system-prompt `## Theme`
 * block surfaces this so the AI knows whether it should evolve the
 * palette for the site being built or treat it as an operator choice.
 */
export type ThemeOrigin = "seed" | "ai" | "operator";

export interface Theme {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly origin: ThemeOrigin;
  readonly isActive: boolean;
  readonly tokens: ThemeDocument;
  readonly assets: {
    readonly logo: ThemeAssetRef | null;
    readonly logoDark: ThemeAssetRef | null;
    readonly favicon: ThemeAssetRef | null;
    readonly socialShare: ThemeAssetRef | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Validate a tokens document. Returns the parsed tree on success;
 * throws a ZodError on failure (caller wraps into the op's HandlerError
 * shape per CLAUDE.md §4).
 */
export function validateThemeTokens(tokens: unknown): ThemeDocument {
  return themeDocument.parse(tokens);
}

/**
 * v0.11.1 (issue #76) — Zod schema for `propose_create_theme.overrides`.
 *
 * The base shape is a permissive `Record<string, unknown>` (same as
 * v0.11.0) so loose names like `primaryColor` / `fontHeading` /
 * `spacing-lg` continue to flow through `normalizeTokens`. The explicit
 * `primaryColor` recognition (v0.11.1) is documented here — when set,
 * the propose-create handler derives a `color.primary.{50..900}`
 * OKLCh ramp from the value (each stop `_derived: true`) instead of
 * landing a single `color.primary` leaf via the normalizer.
 *
 * Operator-supplied `color.primary.<stop>` paths in the same overrides
 * map layer over the derived ramp (explicit-wins precedence).
 */
export const createThemeOverridesSchema = z.record(z.string(), z.unknown());
export type CreateThemeOverrides = z.infer<typeof createThemeOverridesSchema>;

/**
 * v0.11.1 (issue #76) — extract the `primaryColor` sentinel from a
 * loose-name overrides map. Returns `{primaryColor, rest}` where `rest`
 * is the same map minus the `primaryColor` key. Used by the propose-
 * create handler to split the ramp-seed off before normalizing the
 * remaining loose names.
 */
export function extractPrimaryColorSeed(overrides: Record<string, unknown> | undefined): {
  primaryColor: string | undefined;
  rest: Record<string, unknown>;
} {
  if (!overrides) return { primaryColor: undefined, rest: {} };
  const { primaryColor, ...rest } = overrides as { primaryColor?: unknown } & Record<
    string,
    unknown
  >;
  return {
    primaryColor: typeof primaryColor === "string" ? primaryColor : undefined,
    rest,
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Walk a tokens document and produce a flat list of `(path, token)`
 * pairs. Used by the renderer + alias resolver + summary formatter.
 * Paths use dot-notation: `color.primary`, `typography.heading`,
 * `color.brand.primary`, ...
 */
export function flattenTokens(
  tokens: ThemeDocument,
): Array<{ path: string; token: AnyThemeToken }> {
  const out: Array<{ path: string; token: AnyThemeToken }> = [];
  walk(tokens, [], out);
  return out;
}

function walk(
  node: unknown,
  prefix: readonly string[],
  out: Array<{ path: string; token: AnyThemeToken }>,
): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // Leaf: carries `$value`.
  if ("$value" in obj) {
    out.push({ path: prefix.join("."), token: obj as AnyThemeToken });
    return;
  }
  // Group: recurse.
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue; // tolerate DTCG group-level metadata
    walk(v, [...prefix, k], out);
  }
}

/**
 * Build a one-line category summary for the system-prompt `## Theme`
 * block ("8 colors, 5 typography, 6 spacing, 5 radii, 3 shadows").
 */
export function summarizeTokens(tokens: ThemeDocument): string {
  const counts = new Map<string, number>();
  for (const { path } of flattenTokens(tokens)) {
    const category = path.split(".")[0] ?? "(uncategorised)";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) return "no tokens";
  const parts: string[] = [];
  // Stable order so cached system prompts hit.
  for (const k of [
    "color",
    "typography",
    "spacing",
    "radius",
    "shadow",
    "duration",
    "ease",
    "breakpoint",
  ]) {
    const n = counts.get(k);
    if (n) parts.push(`${n} ${pluralise(k, n)}`);
  }
  for (const [k, n] of counts) {
    if (
      ![
        "color",
        "typography",
        "spacing",
        "radius",
        "shadow",
        "duration",
        "ease",
        "breakpoint",
      ].includes(k)
    ) {
      parts.push(`${n} ${k}`);
    }
  }
  return parts.join(", ");
}

function pluralise(category: string, n: number): string {
  if (n === 1) return category;
  if (category === "radius") return "radii";
  if (category.endsWith("y")) return `${category.slice(0, -1)}ies`;
  return `${category}s`;
}

// ────────────────────────────────────────────────────────────────────
// Patch helpers (shared between themes.update_tokens + themes.execute_proposal)
// ────────────────────────────────────────────────────────────────────

/**
 * v0.11.0 (#45, step-11 opt §5) — apply a canonical-path → value patch
 * to a DTCG document. Returns a fresh document; the input is not
 * mutated.
 *
 * Each entry in `writes` becomes a `{$value, $type}` leaf at the dotted
 * canonical path. The `types` map carries the inferred DTCG `$type` for
 * each path (already known to the normalizer) so the leaf advertises
 * the right shape to consumers.
 *
 * Both themes.update_tokens (loose-input set path) and
 * themes.propose_create's execute branch (preset + overrides merge)
 * use this same logic — extracted so the dotted-path merge lives in
 * one place and v0.11.1's OKLCH auto-ramp can extend it without
 * forking.
 */
export function applyDtcgWrites(
  current: ThemeDocument,
  writes: Record<string, unknown>,
  types: Record<string, string>,
): ThemeDocument {
  const out: ThemeDocument = JSON.parse(JSON.stringify(current));
  for (const [path, value] of Object.entries(writes)) {
    const inferredType = types[path];
    // v0.11.0 fix (#45 review thread on theme-normalize.ts:149) — when
    // the incoming value is a partial composite object (e.g. typography's
    // `{fontFamily: "Inter"}` from a loose `fontHeading` input), MERGE
    // it into any existing leaf's `$value` instead of overwriting. This
    // is the only sensible semantics for typography: setting fontFamily
    // must not erase fontSize / fontWeight / etc. set previously.
    const existing = readLeafAtPath(out, path);
    let nextValue: unknown = value;
    if (
      existing &&
      typeof existing === "object" &&
      typeof (existing as { $value?: unknown }).$value === "object" &&
      (existing as { $value: unknown }).$value !== null &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      nextValue = {
        ...(existing as { $value: Record<string, unknown> }).$value,
        ...(value as Record<string, unknown>),
      };
    }
    setLeafAtPath(out, path, {
      $value: nextValue,
      ...(inferredType ? { $type: inferredType } : {}),
    });
  }
  return out;
}

/**
 * Read the existing leaf at a dotted DTCG path, returning the node if
 * it already carries `$value` (i.e. is a token leaf) and `undefined`
 * otherwise. Used by `applyDtcgWrites` to detect composite leaves
 * where the new value should MERGE into the existing `$value` instead
 * of replacing it.
 */
function readLeafAtPath(doc: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = doc;
  for (const k of parts) {
    if (!k) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur && typeof cur === "object" && "$value" in (cur as Record<string, unknown>)) {
    return cur;
  }
  return undefined;
}

/**
 * Walk a dotted DTCG path and set the leaf in-place. Caller passes a
 * cloned document (never the original) — `applyDtcgWrites` enforces
 * that for the public surface.
 */
function setLeafAtPath(doc: Record<string, unknown>, path: string, leaf: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!k) continue;
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last) cur[last] = leaf;
}

/**
 * Companion to `applyDtcgWrites` — drop the leaf at a canonical path
 * if it exists. Returns `{tokens, removed}` so the caller can report
 * which paths were actually removed (silent on missing paths so a
 * remove-list that includes already-absent keys is idempotent).
 */
export function removeDtcgPath(
  doc: ThemeDocument,
  path: string,
): { tokens: ThemeDocument; removed: boolean } {
  const out: ThemeDocument = JSON.parse(JSON.stringify(doc));
  const parts = path.split(".");
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!k) continue;
    const next = cur[k];
    if (!next || typeof next !== "object") return { tokens: doc, removed: false };
    cur = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!last) return { tokens: doc, removed: false };
  if (!(last in cur)) return { tokens: doc, removed: false };
  delete cur[last];
  return { tokens: out, removed: true };
}
