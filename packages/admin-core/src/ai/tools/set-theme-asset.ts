// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: set_theme_asset. Binds one of the theme's four
 * media slots (logo / logo-dark / favicon / social-share) to an
 * uploaded media row.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const setThemeAssetToolInput = z
  .object({
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    slot: z.enum(["logo", "logoDark", "favicon", "socialShare"]),
    mediaId: z.string().uuid().nullable(),
  })
  .strict();
type SetThemeAssetToolInput = z.infer<typeof setThemeAssetToolInput>;

export const setThemeAssetTool: ToolDefinitionWithHandler<SetThemeAssetToolInput> = {
  name: "set_theme_asset",
  description:
    "Bind a theme brand-asset slot to a media row, or clear it with `mediaId: null`. Active theme unless `themeSlug`. " +
    'A bound favicon is emitted as `<link rel="icon">` on every page — never hand-write icon tags in modules.',
  schema: setThemeAssetToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slot", "mediaId"],
    properties: {
      themeSlug: { type: "string", minLength: 1, maxLength: 120 },
      slot: { enum: ["logo", "logoDark", "favicon", "socialShare"] },
      mediaId: {
        type: ["string", "null"],
        format: "uuid",
        description:
          "Media UUID from a `find_media` `id`, an `import_media_from_urls` or `generate_image` result — never a slug/URL, never invented. Favicon: an image row (ICO, PNG, SVG), any raster size (a 64px PNG is derived).",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.set_asset", input);
    if (!r.ok) {
      return { ok: false, content: `themes.set_asset failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      themeId: string;
      asset: { mediaId: string; url: string } | null;
    };
    if (v.asset === null) {
      return { ok: true, content: `cleared theme slot '${input.slot}'` };
    }
    return {
      ok: true,
      content: `bound theme slot '${input.slot}' → media ${v.asset.mediaId} (${v.asset.url})`,
    };
  },
};
