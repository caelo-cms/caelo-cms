// SPDX-License-Identifier: MPL-2.0

/**
 * 0181 — `set_media_source`. AI records an asset's provenance (where it
 * came from) and licence when known, without a human round-trip. The op
 * COALESCEs, so omitted fields stay unchanged — set provenance the first
 * time or patch a single field (e.g. a licence) later.
 */

import { execute } from "@caelo-cms/query-api";
import { setMediaSourceToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setMediaSourceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetMediaSourceToolInput
> = {
  name: "set_media_source",
  description:
    "Record where a media asset came from and its licence when known — the source URL, the " +
    "AI provider/model, or 'upload', plus a licence if the operator states one. " +
    "Use after importing/generating media, or when the operator tells you a licence. " +
    "Only the fields you pass are updated; omitted fields are left unchanged. " +
    "Prefer `set_media_source_many` over multiple `set_media_source` calls when changing more than one.",
  schema: setMediaSourceToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assetId"],
    properties: {
      assetId: { type: "string", format: "uuid" },
      sourceKind: {
        type: "string",
        enum: ["upload", "ai_generated", "imported", "external"],
      },
      sourceDetail: { type: "string", maxLength: 2048 },
      license: { type: "string", maxLength: 200 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "media.set_source", input);
    if (!res.ok) {
      return { ok: false, content: `media.set_source failed: ${describeError(res.error)}` };
    }
    return { ok: true, content: `source recorded on ${input.assetId}` };
  },
};
