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
  description:
    "Mark media assets as `reference` or `library` in ONE transaction (a single asset is a one-item array). " +
    'Use `reference` for images that only guide image generation or editing — a character sheet, a style sample, a product shot to match — when the operator says so or uploads them as references. Reference images are hidden from `find_media` (unless you pass visibility: "all") and a page that uses one fails its deploy. ' +
    "Use `library` to make an asset placeable on pages again (e.g. after a deploy error naming a reference image the operator wants published). Each item is `{assetId, visibility}`; take ids from `find_media`.",
  itemInputSchema: mediaSetVisibilityInputSchema,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assetId", "visibility"],
    properties: {
      assetId: { type: "string", format: "uuid" },
      visibility: { type: "string", enum: ["library", "reference"] },
    },
  },
  opName: "media.set_visibility_many",
});
