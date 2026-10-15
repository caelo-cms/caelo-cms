// SPDX-License-Identifier: MPL-2.0

/**
 * Variation-axis policy for pinned registry faces: which part of a
 * variable font's design space visitors download.
 *
 * A variable face carries its whole design space (Inter: `wght` 100-900
 * and `opsz` 14-32). Most sites use a fraction of it, and every axis kept
 * costs bytes in every slice: Inter's latin slice is 103 KB with all
 * axes, ~50 KB with `wght` clamped to the weights in use and `opsz`
 * pinned. So delivery instantiates the face (harfbuzz) to an
 * {@link EffectiveAxisSpec} per axis:
 *
 *  - `full`  — keep the source range;
 *  - `range` — clamp to `[min, max]` (a sub-range of the source);
 *  - `pin`   — fix the axis at one value; the axis disappears from the
 *              delivered file.
 *
 * Where it comes from: the operator may store an override per face (the
 * `caelo.fontAxes` extension next to `caelo.font` on each typography role
 * bound to the face — see {@link FONT_AXES_EXTENSION}). Axes the override
 * does not name follow the derived default ({@link deriveDefaultAxisSpec}):
 * `wght` clamped to the weights the site can actually render (see
 * `font-usage.ts` for how that set is derived and when it is unknown),
 * every other axis pinned to the font's default — the same choice Google
 * Fonts makes. The one visible consequence of that default is `opsz`:
 * with `font-optical-sizing: auto` the browser would pick the optical
 * size from the font size; pinned, large headings render with the text
 * optical size. That is the trade-off the operator can reverse per face
 * with `{ opsz: "full" }`.
 *
 * Validation is strict (CLAUDE.md §2): an override naming an axis the
 * face does not have, or a value outside the face's source range, is a
 * {@link FontAxisPolicyError} — never silently clamped.
 */

import { z } from "zod";
import { type FontRef, fontRef } from "./font-assets.js";

/** Theme-token extension key holding a role's axis override (beside `caelo.font`). */
export const FONT_AXES_EXTENSION = "caelo.fontAxes";

/** OpenType axis tag: four printable characters (`wght`, `opsz`, `GRAD`). */
export const fontAxisTag = z.string().regex(/^[A-Za-z0-9]{4}$/, "axis tag must be 4 characters");

/** One axis in an operator override. */
export const fontAxisSetting = z.union([
  z.literal("full"),
  z.object({ min: z.number().finite(), max: z.number().finite() }).strict(),
  z.number().finite(),
]);

/** Operator override for one face: axis tag → setting. Unnamed axes use the default. */
export const fontAxisPolicy = z
  .record(fontAxisTag, fontAxisSetting)
  .refine(
    (p) => Object.keys(p).length > 0 && Object.keys(p).length <= 16,
    "name between 1 and 16 axes; pass null to reset the face to the default policy",
  );

export type FontAxisSetting = z.infer<typeof fontAxisSetting>;
export type FontAxisPolicy = z.infer<typeof fontAxisPolicy>;

/** The source design space of one axis, as the registry metadata records it. */
export interface SourceAxis {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** What delivery does with one axis. */
export type EffectiveAxis =
  | { readonly mode: "full"; readonly min: number; readonly max: number }
  | { readonly mode: "range"; readonly min: number; readonly max: number }
  | { readonly mode: "pin"; readonly value: number };

/** Axis tag → effective setting, one entry per source axis, keys sorted. */
export type EffectiveAxisSpec = Readonly<Record<string, EffectiveAxis>>;

/** Where an axis' effective setting came from (for the AI read surface). */
export type AxisOrigin = "override" | "default";

/** Structured, AI-actionable policy failure. */
export class FontAxisPolicyError extends Error {
  readonly code = "FontAxisPolicyInvalid";
  constructor(message: string) {
    super(`FontAxisPolicyInvalid: ${message}`);
    this.name = "FontAxisPolicyError";
  }
}

/** Weight usage as far as the default needs it; `null` = not determinable. */
export interface WeightUsage {
  readonly weights: readonly number[] | null;
  /** Axis tags named in `font-variation-settings` anywhere; `"all"` when unparsable. */
  readonly variationSettingsAxes: readonly string[] | "all";
}

function normalize(axis: SourceAxis, min: number, max: number): EffectiveAxis {
  if (min === max) return { mode: "pin", value: min };
  if (min === axis.min && max === axis.max) return { mode: "full", min, max };
  return { mode: "range", min, max };
}

function sortedSpec(entries: [string, EffectiveAxis][]): EffectiveAxisSpec {
  return Object.fromEntries(entries.sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0)));
}

/**
 * Check an override against the face's real axes.
 *
 * @param subsettable false when OS/2 fsType forbids subsetting: the face
 *   ships byte-complete, so no axis can be instanced either
 * @throws FontAxisPolicyError naming the offending axis and the valid range
 */
export function validateAxisPolicy(
  policy: FontAxisPolicy,
  sourceAxes: Readonly<Record<string, SourceAxis>>,
  subsettable: boolean,
): void {
  const known = Object.keys(sourceAxes).sort();
  for (const [tag, setting] of Object.entries(policy)) {
    const axis = sourceAxes[tag];
    if (axis === undefined) {
      throw new FontAxisPolicyError(
        known.length === 0
          ? `this face is not a variable font (no variation axes), so '${tag}' cannot be set — remove the override`
          : `this face has no '${tag}' axis; its axes are ${known.map((t) => `${t} ${sourceAxes[t]?.min}-${sourceAxes[t]?.max}`).join(", ")}`,
      );
    }
    if (setting === "full") continue;
    if (!subsettable) {
      throw new FontAxisPolicyError(
        `the foundry forbids modifying this face (OS/2 fsType: no subsetting), so it always ships with its full design space — use "full" or reset the override`,
      );
    }
    const [min, max] =
      typeof setting === "number" ? [setting, setting] : [setting.min, setting.max];
    if (min > max) {
      throw new FontAxisPolicyError(`'${tag}' range min ${min} is greater than max ${max}`);
    }
    if (min < axis.min || max > axis.max) {
      throw new FontAxisPolicyError(
        `'${tag}' ${typeof setting === "number" ? `value ${min}` : `range ${min}-${max}`} is outside the face's ${tag} range ${axis.min}-${axis.max}`,
      );
    }
  }
}

/**
 * The policy used when the operator set nothing for an axis.
 *
 * - `wght`: clamped to `[min, max]` of the weights the site can render,
 *   intersected with the source range — or kept full when that set is
 *   not determinable (keeping the full range is the safe outcome, never a
 *   degraded one: the browser simply has every weight available).
 * - every other axis: pinned to the font's default, as Google Fonts
 *   does. Registered axes other than `opsz` are already held at one value
 *   by the single-valued `font-style`/`font-stretch` descriptors the
 *   resolver emits, so pinning them changes nothing visible; `opsz` is
 *   the accepted trade-off described in the file header.
 * - any axis named in `font-variation-settings` somewhere on the site is
 *   kept full: that declaration addresses the axis directly and would
 *   silently stop working on an instanced file.
 * - a face whose fsType forbids subsetting keeps every axis full.
 */
export function deriveDefaultAxisSpec(
  sourceAxes: Readonly<Record<string, SourceAxis>>,
  usage: WeightUsage,
  subsettable: boolean,
): EffectiveAxisSpec {
  const entries: [string, EffectiveAxis][] = [];
  for (const [tag, axis] of Object.entries(sourceAxes)) {
    const addressedDirectly =
      usage.variationSettingsAxes === "all" || usage.variationSettingsAxes.includes(tag);
    if (!subsettable || addressedDirectly) {
      entries.push([tag, { mode: "full", min: axis.min, max: axis.max }]);
    } else if (tag === "wght") {
      if (usage.weights === null || usage.weights.length === 0) {
        entries.push([tag, { mode: "full", min: axis.min, max: axis.max }]);
      } else {
        const lo = Math.min(Math.max(Math.min(...usage.weights), axis.min), axis.max);
        const hi = Math.max(Math.min(Math.max(...usage.weights), axis.max), axis.min);
        entries.push([tag, normalize(axis, lo, hi)]);
      }
    } else {
      entries.push([tag, { mode: "pin", value: axis.default }]);
    }
  }
  return sortedSpec(entries);
}

/**
 * Effective spec for a face: the override's axes win, every other axis
 * follows {@link deriveDefaultAxisSpec}. Also reports where each axis
 * came from.
 *
 * @throws FontAxisPolicyError when the override does not fit the face
 */
export function effectiveAxisSpec(
  sourceAxes: Readonly<Record<string, SourceAxis>>,
  override: FontAxisPolicy | null,
  usage: WeightUsage,
  subsettable: boolean,
): { readonly spec: EffectiveAxisSpec; readonly origin: Readonly<Record<string, AxisOrigin>> } {
  if (override !== null) validateAxisPolicy(override, sourceAxes, subsettable);
  const defaults = deriveDefaultAxisSpec(sourceAxes, usage, subsettable);
  const entries: [string, EffectiveAxis][] = [];
  const origin: Record<string, AxisOrigin> = {};
  for (const [tag, axis] of Object.entries(sourceAxes)) {
    const setting = override?.[tag];
    if (setting === undefined) {
      const derived = defaults[tag];
      if (derived === undefined) throw new Error(`default spec lacks source axis ${tag}`);
      entries.push([tag, derived]);
      origin[tag] = "default";
    } else {
      const [min, max] =
        setting === "full"
          ? [axis.min, axis.max]
          : typeof setting === "number"
            ? [setting, setting]
            : [setting.min, setting.max];
      entries.push([tag, normalize(axis, min, max)]);
      origin[tag] = "override";
    }
  }
  return { spec: sortedSpec(entries), origin };
}

/** True when delivery would ship the face's design space untouched. */
export function isFullAxisSpec(spec: EffectiveAxisSpec): boolean {
  return Object.values(spec).every((a) => a.mode === "full");
}

/**
 * Canonical text form of a spec (`opsz=14;wght=400..900`), stable across
 * key order. Delivery hashes it into cache keys and file names, so a
 * policy change can never be answered with slices cut for another one.
 */
export function axisSpecKey(spec: EffectiveAxisSpec): string {
  return Object.keys(spec)
    .sort()
    .map((tag) => {
      const a = spec[tag] as EffectiveAxis;
      return a.mode === "pin" ? `${tag}=${a.value}` : `${tag}=${a.min}..${a.max}`;
    })
    .join(";");
}

/**
 * Axes a delivered file must report after instancing: pinned axes are
 * gone, the rest carry their (possibly clamped) range.
 */
export function expectedOutputAxes(
  spec: EffectiveAxisSpec,
): Record<string, { min: number; max: number }> {
  const out: Record<string, { min: number; max: number }> = {};
  for (const tag of Object.keys(spec).sort()) {
    const a = spec[tag] as EffectiveAxis;
    if (a.mode !== "pin") out[tag] = { min: a.min, max: a.max };
  }
  return out;
}

/**
 * The `@font-face` `font-weight` descriptor matching the delivered file,
 * so the browser neither requests nor synthesizes outside it.
 *
 * @param staticWeight the face's OS/2 weight, used when it has no `wght` axis
 */
export function fontWeightDescriptor(spec: EffectiveAxisSpec, staticWeight: number): string {
  const wght = spec.wght;
  if (wght === undefined) return String(staticWeight);
  return wght.mode === "pin" ? String(wght.value) : `${wght.min} ${wght.max}`;
}

/** The weights a face actually serves, as `[min, max]`. */
export function servedWeightRange(
  spec: EffectiveAxisSpec,
  staticWeight: number,
): readonly [number, number] {
  const wght = spec.wght;
  if (wght === undefined) return [staticWeight, staticWeight];
  return wght.mode === "pin" ? [wght.value, wght.value] : [wght.min, wght.max];
}

/** One typography role bound to a pinned face. */
export interface PinnedRole {
  readonly role: string;
  readonly fontFamily: string | undefined;
  readonly fontWeight: number | string | undefined;
  readonly fontStyle: string | undefined;
}

/** A pinned face with every role that binds it and its stored override. */
export interface PinnedFaceBinding {
  readonly ref: FontRef;
  readonly roles: readonly PinnedRole[];
  /** The `caelo.fontAxes` override the face's roles carry; null = default policy. */
  readonly override: FontAxisPolicy | null;
}

function canonicalPolicy(policy: FontAxisPolicy | null): string {
  if (policy === null) return "null";
  return JSON.stringify(
    Object.keys(policy)
      .sort()
      .map((tag) => [tag, policy[tag]]),
  );
}

/**
 * Group the theme's `caelo.font` bindings by face (sha256), in role
 * order. The override belongs to the FACE — one file, one `@font-face`
 * set — so every role bound to the same face must carry the same
 * `caelo.fontAxes` (themes.update_tokens keeps them in step). Roles
 * whose binding does not parse are skipped here; the resolver reports
 * those itself.
 *
 * @throws FontAxisPolicyError when a stored override is malformed or two
 *   roles of one face disagree
 */
export function collectPinnedFaces(tokens: unknown): PinnedFaceBinding[] {
  const typography = (tokens as { typography?: unknown } | null)?.typography;
  if (typography === null || typeof typography !== "object") return [];
  const byFace = new Map<
    string,
    { ref: FontRef; roles: PinnedRole[]; policies: Set<string>; override: FontAxisPolicy | null }
  >();
  for (const [role, raw] of Object.entries(typography as Record<string, unknown>)) {
    const entry = raw as {
      $extensions?: Record<string, unknown>;
      $value?: { fontFamily?: string; fontWeight?: number | string; fontStyle?: string };
    };
    const ref = fontRef.safeParse(entry?.$extensions?.["caelo.font"]);
    if (!ref.success) continue;
    const stored = entry.$extensions?.[FONT_AXES_EXTENSION];
    let override: FontAxisPolicy | null = null;
    if (stored !== undefined) {
      const parsed = fontAxisPolicy.safeParse(stored);
      if (!parsed.success) {
        throw new FontAxisPolicyError(
          `typography.${role} carries a malformed ${FONT_AXES_EXTENSION} (${parsed.error.issues[0]?.message ?? "invalid"}) — reset it with set_theme_tokens fontAxes: { ${role}: null }`,
        );
      }
      override = parsed.data;
    }
    const face = byFace.get(ref.data.sha256) ?? {
      ref: ref.data,
      roles: [],
      policies: new Set<string>(),
      override,
    };
    face.roles.push({
      role,
      fontFamily: entry.$value?.fontFamily,
      fontWeight: entry.$value?.fontWeight,
      fontStyle: entry.$value?.fontStyle,
    });
    face.policies.add(canonicalPolicy(override));
    byFace.set(ref.data.sha256, face);
  }
  return [...byFace.values()].map((face) => {
    if (face.policies.size > 1) {
      throw new FontAxisPolicyError(
        `roles ${face.roles.map((r) => r.role).join(", ")} bind the same font file but carry different axis overrides — set one override for the face with set_theme_tokens fontAxes (it applies to every role using that file)`,
      );
    }
    return { ref: face.ref, roles: face.roles, override: face.override };
  });
}
