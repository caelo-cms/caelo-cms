// SPDX-License-Identifier: MPL-2.0

/**
 * #531 — mark assets as `reference` (guides image generation/editing, never
 * placed on a page) or back to `library`. Bulk-only (CLAUDE.md §11: a single
 * change is a one-item array); dispatches `media.set_visibility_many`.
 */

import { mediaSetVisibilityInputSchema } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setMediaVisibilityManyTool = makeBulkTool({
  name: "set_media_visibility_many",
  description: "Mark media assets `reference` or `library` in one tx (ids from `find_media`).",
  itemInputSchema: mediaSetVisibilityInputSchema,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assetId", "visibility"],
    properties: {
      assetId: { type: "string", format: "uuid" },
      visibility: {
        type: "string",
        enum: ["library", "reference"],
        description:
          '`reference`: only guides image generation/editing (character sheet, style sample, product shot to match) — when the operator says so or uploads references; hidden from `find_media` (unless visibility "all"), a page using one fails its deploy. `library`: placeable on pages again (e.g. after a deploy error naming a reference image the operator wants published).',
      },
    },
  },
  opName: "media.set_visibility_many",
});
