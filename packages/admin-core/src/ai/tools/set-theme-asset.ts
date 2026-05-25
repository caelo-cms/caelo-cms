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
    "Bind one of the theme's brand assets (logo / logoDark / favicon / socialShare) to an " +
    "uploaded media row. Pass `mediaId: null` to clear a slot. The mediaId must reference a " +
    "row in `media_assets` — upload via /api/media/upload first if needed (search existing " +
    "uploads with `find_media`). Targets the active theme by default; pass `themeSlug` to " +
    "bind on a specific theme.",
  schema: setThemeAssetToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slot", "mediaId"],
    properties: {
      themeSlug: { type: "string", minLength: 1, maxLength: 120 },
      slot: { enum: ["logo", "logoDark", "favicon", "socialShare"] },
      mediaId: { type: ["string", "null"], format: "uuid" },
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
