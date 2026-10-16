// SPDX-License-Identifier: MPL-2.0

/**
 * Variation-axis policy of pinned faces on the theme surface — the write
 * half (`fontAxes` on themes.update_tokens). The read half is
 * `themes.font_delivery` (theme-font-delivery.ts).
 *
 * Storage: the override is face-level data stored beside the binding —
 * `$extensions["caelo.fontAxes"]` next to `$extensions["caelo.font"]` on
 * every typography role bound to that face. One file is one @font-face
 * set, so all roles of a face carry the same override; the write path
 * fans an override out to every role of the face and copies it onto a
 * role newly bound to it, and `collectPinnedFaces` fails loudly if they
 * ever disagree. Operators (and the AI on their behalf) speak in roles —
 * "keep the optical sizes on the headings" — so the input is keyed by
 * role and resolved to the face here.
 */

import { inspectFontOp } from "@caelo-cms/font-service";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  FONT_AXES_EXTENSION,
  type FontAxisPolicy,
  FontAxisPolicyError,
  fontAxisPolicy,
  fontRef,
  ok,
  type Result,
  validateAxisPolicy,
} from "@caelo-cms/shared";
import { z } from "zod";

/** themes.update_tokens `fontAxes` input: role → override, or null to reset. */
export const fontAxesInput = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/),
  fontAxisPolicy.nullable(),
);

type Leaf = { $value?: unknown; $extensions?: Record<string, unknown> };
type HandlerError = { kind: "HandlerError"; operation: string; message: string };

function boundSha(leaf: unknown): string | null {
  const ref = fontRef.safeParse((leaf as Leaf | undefined)?.$extensions?.["caelo.font"]);
  return ref.success ? ref.data.sha256 : null;
}

function numericWeight(raw: unknown): number | null {
  if (raw === "normal") return 400;
  if (raw === "bold") return 700;
  return typeof raw === "number" ? raw : null;
}

/**
 * The override a role newly bound to `sha256` must carry so the face's
 * roles stay in step: the one another role of that face already has, or
 * its own previous one when it was re-bound to the same face, else none.
 */
export function overrideForNewBinding(
  typography: Record<string, unknown>,
  role: string,
  sha256: string,
  previous: Leaf | undefined,
): unknown {
  for (const [other, leaf] of Object.entries(typography)) {
    if (other !== role && boundSha(leaf) === sha256) {
      return (leaf as Leaf).$extensions?.[FONT_AXES_EXTENSION];
    }
  }
  return boundSha(previous) === sha256 ? previous?.$extensions?.[FONT_AXES_EXTENSION] : undefined;
}

/**
 * Apply role-keyed overrides to `typography` in place (face-wide).
 *
 * @returns the roles written, or an AI-actionable HandlerError
 */
export async function applyFontAxisOverrides(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  typography: Record<string, unknown>,
  fontAxes: z.infer<typeof fontAxesInput>,
): Promise<Result<string[], HandlerError>> {
  const fail = (message: string) =>
    err({ kind: "HandlerError" as const, operation: "themes.update_tokens", message });
  const byFace = new Map<string, { policy: FontAxisPolicy | null; via: string }>();
  for (const [role, policy] of Object.entries(fontAxes)) {
    const leaf = typography[role] as Leaf | undefined;
    const ref = fontRef.safeParse(leaf?.$extensions?.["caelo.font"]);
    if (!ref.success) {
      return fail(
        `typography.${role} has no pinned font file, so it has no axes to set — bind one first with set_theme_tokens fontBindings (find_fonts / acquire_font give the {id, sha256})`,
      );
    }
    const face = await inspectFontOp.handler(ctx, ref.data, tx);
    if (!face.ok) return fail(`typography.${role}: its pinned font could not be read`);
    if (policy !== null) {
      try {
        validateAxisPolicy(policy, face.value.axes, face.value.embedding.subset);
      } catch (e) {
        if (e instanceof FontAxisPolicyError) return fail(`typography.${role}: ${e.message}`);
        throw e;
      }
    }
    const previous = byFace.get(ref.data.sha256);
    if (previous && JSON.stringify(previous.policy) !== JSON.stringify(policy)) {
      return fail(
        `typography.${previous.via} and typography.${role} use the same font file, and the axis policy belongs to the file — pass one policy for it (it applies to every role using that file)`,
      );
    }
    byFace.set(ref.data.sha256, { policy, via: role });
  }
  const written: string[] = [];
  for (const [role, leaf] of Object.entries(typography)) {
    const sha = boundSha(leaf);
    const target = sha === null ? undefined : byFace.get(sha);
    if (target === undefined) continue;
    const extensions = { ...((leaf as Leaf).$extensions ?? {}) };
    if (target.policy === null) delete extensions[FONT_AXES_EXTENSION];
    else extensions[FONT_AXES_EXTENSION] = target.policy;
    typography[role] = { ...(leaf as Leaf), $extensions: extensions };
    written.push(`typography.${role}`);
  }
  return ok(written);
}

/**
 * A role whose weight an override's `wght` excludes would never render
 * at that weight (the resolver refuses it), so every write that touches
 * typography is checked: fontAxes, fontBindings inheriting an override,
 * and `set` changing a role's fontWeight. A role without a numeric
 * weight renders at the face's own weight, which the resolver checks.
 *
 * @returns an AI-actionable message for the first conflict, else null
 */
export function overrideWeightConflict(typography: Record<string, unknown>): string | null {
  for (const [role, leaf] of Object.entries(typography)) {
    if (boundSha(leaf) === null) continue;
    const parsed = fontAxisPolicy.safeParse((leaf as Leaf).$extensions?.[FONT_AXES_EXTENSION]);
    const wght = parsed.success ? parsed.data.wght : undefined;
    if (wght === undefined || wght === "full") continue;
    const [lo, hi] = typeof wght === "number" ? [wght, wght] : [wght.min, wght.max];
    const value = (leaf as Leaf).$value as { fontWeight?: unknown } | undefined;
    const weight = numericWeight(value?.fontWeight);
    if (weight !== null && (weight < lo || weight > hi)) {
      return `typography.${role} uses weight ${weight}, outside the wght ${lo === hi ? `pin ${lo}` : `range ${lo}-${hi}`} set for its font file — widen the range to include ${weight} (set_theme_tokens fontAxes), or change that role's fontWeight`;
    }
  }
  return null;
}
