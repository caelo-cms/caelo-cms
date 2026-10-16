// SPDX-License-Identifier: MPL-2.0

/**
 * `themes.font_delivery` — what visitors download for each pinned face of
 * a theme: the source design space, the operator override (if any), the
 * effective axis spec with the origin of each axis, the derived site
 * weight usage (or why it is unknown), the `font-weight` descriptor, and
 * the slice sizes when a preview or build has already derived them.
 *
 * It answers the AI's "make the fonts load faster" / "what are we
 * shipping?" without a build: everything is computed from the same
 * inputs the resolver uses (`collectPinnedFaces`, `loadSiteFontUsage`,
 * `effectiveAxisSpec`), so it cannot disagree with preview or deploy.
 * Sizes come only from the slice cache — deriving here would make a read
 * cost seconds — so `delivered` is null until something renders.
 */

import { inspectFontOp } from "@caelo-cms/font-service";
import { defineOperation } from "@caelo-cms/query-api";
import {
  type AxisOrigin,
  collectPinnedFaces,
  type EffectiveAxisSpec,
  effectiveAxisSpec,
  err,
  FontAxisPolicyError,
  fontAxisPolicy,
  fontWeightDescriptor,
  ok,
} from "@caelo-cms/shared";
import {
  cachedPinnedFaceSlices,
  defaultFontsCacheDir,
  loadSiteFontUsage,
} from "@caelo-cms/static-generator";
import { z } from "zod";
import { fetchThemeOrNull } from "./themes.js";

const effectiveAxis = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full"), min: z.number(), max: z.number() }),
  z.object({ mode: z.literal("range"), min: z.number(), max: z.number() }),
  z.object({ mode: z.literal("pin"), value: z.number() }),
]);

const faceDelivery = z.object({
  fontId: z.string(),
  sha256: z.string(),
  family: z.string(),
  roles: z.array(z.object({ role: z.string(), fontWeight: z.unknown() })),
  sourceAxes: z.record(
    z.string(),
    z.object({ min: z.number(), max: z.number(), default: z.number() }),
  ),
  /** True when OS/2 fsType forbids subsetting: the face ships whole. */
  locked: z.boolean(),
  override: fontAxisPolicy.nullable(),
  effective: z.record(z.string(), effectiveAxis),
  origin: z.record(z.string(), z.enum(["override", "default"])),
  fontWeightDescriptor: z.string(),
  /** Sizes of the slices for this spec when already derived (by a preview/build), else null. */
  delivered: z
    .object({
      slices: z.array(z.object({ subset: z.string(), bytes: z.number() })),
      totalBytes: z.number(),
    })
    .nullable(),
  /** Error naming why the face cannot be resolved; the other fields are then best-effort. */
  error: z.string().nullable(),
});

export const themeFontDeliveryOp = defineOperation({
  name: "themes.font_delivery",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ themeSlug: z.string().min(1).max(120).optional() }).strict(),
  output: z.object({
    themeSlug: z.string(),
    weightUsage: z.object({
      weights: z.array(z.number()).nullable(),
      uncertain: z.array(z.string()),
      variationSettingsAxes: z.union([z.array(z.string()), z.literal("all")]),
    }),
    faces: z.array(faceDelivery),
  }),
  handler: async (ctx, input, tx) => {
    const theme = input.themeSlug
      ? await fetchThemeOrNull(tx, { slug: input.themeSlug })
      : await fetchThemeOrNull(tx, { active: true });
    if (!theme) {
      return err({
        kind: "HandlerError",
        operation: "themes.font_delivery",
        message: input.themeSlug
          ? `theme '${input.themeSlug}' not found — call list_themes`
          : "no active theme — call list_themes",
      });
    }
    let faces: ReturnType<typeof collectPinnedFaces>;
    try {
      faces = collectPinnedFaces(theme.tokens);
    } catch (e) {
      if (!(e instanceof FontAxisPolicyError)) throw e;
      return err({ kind: "HandlerError", operation: "themes.font_delivery", message: e.message });
    }
    const usage = await loadSiteFontUsage(tx, theme.tokens);
    const cacheDir = defaultFontsCacheDir(process.cwd());
    const out: z.infer<typeof faceDelivery>[] = [];
    for (const face of faces) {
      const inspected = await inspectFontOp.handler(ctx, face.ref, tx);
      if (!inspected.ok) {
        return err({
          kind: "HandlerError",
          operation: "themes.font_delivery",
          message: `pinned font ${face.ref.id} (${face.roles.map((r) => r.role).join(", ")}) could not be read`,
        });
      }
      const metadata = inspected.value;
      let effective: EffectiveAxisSpec = {};
      let origin: Record<string, AxisOrigin> = {};
      let error: string | null = null;
      try {
        ({ spec: effective, origin } = effectiveAxisSpec(
          metadata.axes,
          face.override,
          usage,
          metadata.embedding.subset,
        ));
      } catch (e) {
        if (!(e instanceof FontAxisPolicyError)) throw e;
        error = e.message;
      }
      const cached =
        error === null
          ? await cachedPinnedFaceSlices({ cacheDir, sha256: face.ref.sha256, axisSpec: effective })
          : null;
      out.push({
        fontId: face.ref.id,
        sha256: face.ref.sha256,
        family: metadata.family,
        roles: face.roles.map((r) => ({ role: r.role, fontWeight: r.fontWeight ?? null })),
        sourceAxes: metadata.axes,
        locked: !metadata.embedding.subset,
        override: face.override,
        effective,
        origin,
        fontWeightDescriptor: fontWeightDescriptor(effective, metadata.weight),
        delivered:
          cached === null
            ? null
            : {
                slices: cached.slices.map((s) => ({ subset: s.subset, bytes: s.bytes })),
                totalBytes: cached.slices.reduce((n, s) => n + s.bytes, 0),
              },
        error,
      });
    }
    return ok({
      themeSlug: theme.slug,
      weightUsage: {
        weights: usage.weights === null ? null : [...usage.weights],
        uncertain: [...usage.uncertain],
        variationSettingsAxes:
          usage.variationSettingsAxes === "all" ? "all" : [...usage.variationSettingsAxes],
      },
      faces: out,
    });
  },
});
