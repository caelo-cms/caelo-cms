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
    "What the configured image model supports, read before `generate_image` / `edit_image`: operations, reference count + size/format limits, mask edits, output sizes, native resolutions, budget reserved per request. Free.",
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
