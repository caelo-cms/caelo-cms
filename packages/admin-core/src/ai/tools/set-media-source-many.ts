// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_media_source_many — records provenance + licence on 1..N
 * assets in one transaction (the former singular set_media_source is its n=1
 * case; retired-tools.ts maps old calls here). Built from the `makeBulkTool`
 * factory; dispatches `media.set_source_many` (COALESCE: omitted fields stay
 * unchanged). All-or-nothing.
 */

import { setMediaSourceToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setMediaSourceManyTool = makeBulkTool({
  name: "set_media_source_many",
  description: [
    "Record assets' provenance (`sourceDetail` = source URL or AI provider/model) + licence (only one the operator states), all-or-nothing. Use after importing/generating media or when told a licence. Only passed fields change.",
  ].join("\n"),
  itemInputSchema: setMediaSourceToolInput,
  itemJsonSchema: {
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
  opName: "media.set_source_many",
});
