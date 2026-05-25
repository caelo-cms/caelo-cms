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
        .tuple([
          z.number().min(0).max(1),
          z.number(),
          z.number().min(0).max(1),
          z.number(),
        ])
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
 * One category group: a flat record of token-name → token, OR (for
 * nested groups like `color.brand.*`) a record of sub-name → group.
 * DTCG allows arbitrary nesting; we lazy-recurse to support it.
 */
type TokenGroup = {
  [k: string]: TokenGroup | z.infer<typeof anyThemeToken>;
};

const tokenGroupSchema: z.ZodType<TokenGroup> = z.lazy(() =>
  z.record(
    z.string(),
    z.union([
      anyThemeToken,
      tokenGroupSchema,
    ]),
  ),
);

/**
 * Top-level DTCG document. Known category keys at v0.11.0:
 *
 *   color, typography, spacing, radius, shadow, motion (duration +
 *   cubicBezier sub-groups), breakpoint.
 *
 * Plus `$extensions` for tooling metadata (passed through unmodified
 * by import/export).
 *
 * Unknown root keys are tolerated because DTCG explicitly leaves the
 * category vocabulary open — we don't want to reject a future
 * `effect` or `gradient` category that operators bring from Figma.
 */
export const themeDocument = z.record(z.string(), tokenGroupSchema);

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

export interface Theme {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
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
    setLeafAtPath(out, path, {
      $value: value,
      ...(inferredType ? { $type: inferredType } : {}),
    });
  }
  return out;
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
