// SPDX-License-Identifier: MPL-2.0

/**
 * `get_image_capabilities` (#529) — what the configured image model
 * accepts, so the AI plans a request that fits instead of trying and
 * failing: operations (generate / edit), reference limits, masks, sizes,
 * native resolutions, and the amount reserved per request.
 */

import { z } from "zod";
import { resolveImageModel } from "../image-service.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z.object({}).strict();

export const getImageCapabilitiesTool: ToolDefinitionWithHandler<z.infer<typeof input>> = {
  name: "get_image_capabilities",
  description:
    "Read what the configured image model can do before calling generate_image or edit_image: supported operations, how many reference images (and their size/format limits), whether edits can use a mask, output sizes, native resolutions, and the budget reserved per request. Free; no image is generated.",
  schema: input,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  handler: async (ctx, _input, toolCtx) => {
    const configured = await resolveImageModel(ctx, toolCtx);
    if ("error" in configured) {
      return { ok: false, content: `get_image_capabilities: ${configured.error}` };
    }
    return {
      ok: true,
      content: JSON.stringify({
        ...configured.capabilities,
        reservedPerRequestUsd: configured.reserveMicrocents / 1e8,
      }),
    };
  },
};
