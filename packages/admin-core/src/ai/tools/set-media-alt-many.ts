// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_media_alt_many — replaces alt text on 1..N assets in one
 * transaction (the former singular set_media_alt is its n=1 case;
 * retired-tools.ts maps old calls here). Built from the `makeBulkTool`
 * factory; dispatches `media.update_alt_many`. All-or-nothing.
 */

import { setMediaAltToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setMediaAltManyTool = makeBulkTool({
  name: "set_media_alt_many",
  description:
    "Replace alt text on assets (all-or-nothing) when you have visual context or an a11y request and the alt is missing/unhelpful. Never invent alt for an image you can't identify — omit that item. `assetId` = `id` from `find_media` or an `import_media_from_urls`/`generate_image` result.",
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
