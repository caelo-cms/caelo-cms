// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk variant of `set_content_instance_values` — edits N content_instances in
 * one transaction. Built from the `makeBulkTool` factory; dispatches
 * `content_instances.set_values_many` (which reuses the singular handler per
 * item). All-or-nothing: any invalid item aborts the whole batch.
 */

import { setContentInstanceValuesToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setContentInstanceValuesManyTool = makeBulkTool({
  name: "set_content_instance_values_many",
  description:
    "Edit SEVERAL content_instances in ONE transaction — prefer this over multiple `set_content_instance_values` calls whenever you change more than one (§11 bulk-first: one round-trip + one snapshot instead of N). All-or-nothing: any invalid item aborts the whole batch (the error names `items[i]`) and nothing is written. " +
    "**Same per-item BLAST RADIUS caveat as the singular tool:** each item propagates to EVERY placement bound to that instance with sync_mode='synced' — read `## Content Library` first. `values` fully replaces existing values (zero-merge) per item. " +
    "Each item is the exact `set_content_instance_values` shape: `{id, values, expectedVersion?, slug?, displayName?, purpose?}`.",
  itemInputSchema: setContentInstanceValuesToolInput,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "values"],
    properties: {
      id: { type: "string", format: "uuid" },
      values: { type: "object", additionalProperties: true },
      expectedVersion: { type: "integer", minimum: 0 },
      slug: { type: ["string", "null"], pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      displayName: { type: ["string", "null"], minLength: 1, maxLength: 128 },
      purpose: { type: ["string", "null"], maxLength: 1000 },
    },
  },
  opName: "content_instances.set_values_many",
});
