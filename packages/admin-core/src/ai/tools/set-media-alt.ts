// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — `set_media_alt`. AI improves a11y on an existing asset
 * without a human round-trip. Narrow surface — only the alt field is
 * touched; the rest of `media_assets` is human-only.
 */

import { execute } from "@caelo-cms/query-api";
import { setMediaAltToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setMediaAltTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetMediaAltToolInput
> = {
  name: "set_media_alt",
  description:
    "Replace an asset's alt text. Use when you have visual context for an image " +
    "(or the user asks you to improve a11y) and the existing alt is missing or unhelpful. " +
    "Doesn't move bytes around — only updates the alt field on `media_assets`. " +
    "If you don't know what an image depicts, do NOT invent alt text — leave it alone.",
  schema: setMediaAltToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assetId", "alt"],
    properties: {
      assetId: { type: "string", format: "uuid" },
      alt: { type: "string", maxLength: 2048 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "media.update_alt", input);
    if (!res.ok) {
      return { ok: false, content: `media.update_alt failed: ${describeError(res.error)}` };
    }
    return { ok: true, content: `alt set on ${input.assetId} (${input.alt.length} chars)` };
  },
};
