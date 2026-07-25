// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk variant of `set_media_alt` — replaces alt text on N assets in one
 * transaction. Built from the `makeBulkTool` factory; dispatches
 * `media.update_alt_many`. All-or-nothing: any invalid item aborts the batch.
 */

import { setMediaAltToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setMediaAltManyTool = makeBulkTool({
  name: "set_media_alt_many",
  description:
    "Replace alt text on SEVERAL assets in ONE transaction — prefer this over multiple `set_media_alt` calls whenever you improve a11y on more than one image (§11 bulk-first). All-or-nothing: any invalid item aborts the whole batch. " +
    "Same rule as the singular tool: if you don't know what an image depicts, do NOT invent alt text — leave that item out. Each item is `{assetId, alt}`.",
  itemInputSchema: setMediaAltToolInput,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assetId", "alt"],
    properties: {
      assetId: { type: "string", format: "uuid" },
      alt: { type: "string", maxLength: 2048 },
    },
  },
  opName: "media.update_alt_many",
});
