// SPDX-License-Identifier: MPL-2.0

/**
 * `edit_image` (#528) — change an existing media image from a prompt,
 * optionally only where a mask allows, guided by reference images. Same
 * lifecycle as `generate_image` (ai/image-service.ts): capability check,
 * budget reserved before the paid call, result saved to the media library
 * as a new asset that points at its source (`derivedFromId`), provenance
 * recorded. The source asset itself is never modified.
 */

import { z } from "zod";
import { loadSourceImages, resolveImageModel, runImageRequest } from "../image-service.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const editImageInput = z
  .object({
    /** Media id or slug of the image to change. */
    source: z.string().min(1).max(200),
    prompt: z.string().min(1).max(4000),
    /** Media id or slug of a PNG whose transparent area may change. */
    mask: z.string().min(1).max(200).optional(),
    references: z.array(z.string().min(1).max(200)).max(15).default([]),
    size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).optional(),
    quality: z.enum(["standard", "hd"]).default("standard"),
    imageSize: z.enum(["1K", "2K", "4K"]).optional(),
    altText: z.string().max(500).optional(),
  })
  .strict();

export type EditImageInput = z.infer<typeof editImageInput>;

export const editImageTool: ToolDefinitionWithHandler<EditImageInput> = {
  name: "edit_image",
  description:
    'Change an EXISTING image from the media library with a prompt ("make the sky dusk", "remove the logo") — the result is a NEW media asset linked to its source; the source is never modified. ' +
    "`source` is a media id or slug (find_media). Optional `mask`: a PNG from the media library whose transparent area marks what may change — only on models that support masks; otherwise describe the region in the prompt. Optional `references` guide the look. " +
    "Check get_image_capabilities first: whether the model can edit, mask support, reference limits. Requests outside them are refused before anything is paid. " +
    "Each call reserves the image budget first; `ImageBudgetExceeded` means tell the operator instead of retrying. For a brand-new image use generate_image.",
  schema: editImageInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["source", "prompt"],
    properties: {
      source: { type: "string" },
      prompt: { type: "string" },
      mask: { type: "string" },
      references: { type: "array", items: { type: "string" }, maxItems: 15 },
      size: { type: "string", enum: ["1024x1024", "1792x1024", "1024x1792"] },
      quality: { type: "string", enum: ["standard", "hd"] },
      imageSize: { type: "string", enum: ["1K", "2K", "4K"] },
      altText: { type: "string" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const configured = await resolveImageModel(ctx, toolCtx);
    if ("error" in configured) return { ok: false, content: `edit_image: ${configured.error}` };
    const sources = await loadSourceImages(ctx, toolCtx, [input.source, ...input.references]);
    if ("error" in sources) return { ok: false, content: `edit_image: ${sources.error}` };
    let mask: (typeof sources)[number] | undefined;
    if (input.mask) {
      const loaded = await loadSourceImages(ctx, toolCtx, [input.mask]);
      if ("error" in loaded) return { ok: false, content: `edit_image: mask ${loaded.error}` };
      mask = loaded[0];
    }
    return runImageRequest({
      ctx,
      toolCtx,
      configured,
      operation: "edit",
      prompt: input.prompt,
      sources,
      ...(mask ? { mask } : {}),
      ...(input.size ? { size: input.size } : {}),
      quality: input.quality,
      ...(input.imageSize ? { imageSize: input.imageSize } : {}),
      ...(input.altText ? { altText: input.altText } : {}),
    });
  },
};
