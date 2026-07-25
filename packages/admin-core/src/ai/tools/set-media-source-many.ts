// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk variant of `set_media_source` — records provenance + licence on N assets
 * in one transaction. Built from the `makeBulkTool` factory; dispatches
 * `media.set_source_many`. All-or-nothing: any invalid item aborts the batch.
 */

import { setMediaSourceToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setMediaSourceManyTool = makeBulkTool({
  name: "set_media_source_many",
  description:
    "Record provenance + licence on SEVERAL assets in ONE transaction — prefer this over multiple `set_media_source` calls whenever you tag more than one asset (§11 bulk-first). All-or-nothing: any invalid item aborts the whole batch. " +
    "Same COALESCE semantics as the singular tool: per item, only the fields you pass are updated; omitted fields stay unchanged. Each item is `{assetId, sourceKind?, sourceDetail?, license?}`.",
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
