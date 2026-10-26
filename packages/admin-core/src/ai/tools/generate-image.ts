// SPDX-License-Identifier: MPL-2.0

/**
 * `generate_image` — a new image from a prompt, optionally guided by
 * reference images from the media library (#527). Runs through the shared
 * image lifecycle (ai/image-service.ts): capability check, budget reserved
 * before the paid call, persisted to the media library, actual cost
 * settled, provenance recorded. A replayed call never pays twice.
 */

import { z } from "zod";
import { loadSourceImages, resolveImageModel, runImageRequest } from "../image-service.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const generateImageInput = z
  .object({
    prompt: z.string().min(1).max(4000),
    size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).default("1024x1024"),
    quality: z.enum(["standard", "hd"]).default("standard"),
    /** Native resolution on models that offer it (see get_image_capabilities). */
    imageSize: z.enum(["1K", "2K", "4K"]).optional(),
    /** Media ids or slugs whose look the image should follow. */
    references: z.array(z.string().min(1).max(200)).max(14).default([]),
    /** Owner-readable label saved alongside the media row's title. */
    altText: z.string().max(500).optional(),
  })
  .strict();

export type GenerateImageInput = z.infer<typeof generateImageInput>;

export const generateImageTool: ToolDefinitionWithHandler<GenerateImageInput> = {
  name: "generate_image",
  usesInstallAi: true,
  description:
    "Generate a NEW image from a prompt with the configured image model; saved to the media library, returns mediaId + url (use the url verbatim in `<img src>`). EXISTING image -> `edit_image`.\n" +
    "- Check `get_image_capabilities` first (reference count, sizes, resolutions); requests outside them are refused before anything is paid.\n" +
    "- Rarely cheap: verify the prompt is on-brand. Budget reserved per call; `ImageBudgetExceeded` -> tell the operator, don't retry.",
  schema: generateImageInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      size: { type: "string", enum: ["1024x1024", "1792x1024", "1024x1792"] },
      quality: { type: "string", enum: ["standard", "hd"] },
      imageSize: {
        type: "string",
        enum: ["1K", "2K", "4K"],
        description:
          "2K/4K only if `get_image_capabilities` lists them, else omit (1K works on every model).",
      },
      references: {
        type: "array",
        items: { type: "string" },
        maxItems: 14,
        description:
          'Media ids/slugs (`find_media`, incl. `visibility:"reference"`) to keep a character, product or style consistent.',
      },
      altText: { type: "string" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const configured = await resolveImageModel(ctx, toolCtx);
    if ("error" in configured) return { ok: false, content: `generate_image: ${configured.error}` };
    const sources = await loadSourceImages(ctx, toolCtx, input.references);
    if ("error" in sources) return { ok: false, content: `generate_image: ${sources.error}` };
    return runImageRequest({
      ctx,
      toolCtx,
      configured,
      operation: "generate",
      prompt: input.prompt,
      sources,
      size: input.size,
      quality: input.quality,
      ...(input.imageSize ? { imageSize: input.imageSize } : {}),
      ...(input.altText ? { altText: input.altText } : {}),
    });
  },
};
