// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: set_content_instance_values. Edits the values of
 * one content_instance. The blast radius equals the row's placementCount:
 * editing a shared instance propagates to every page bound to it.
 *
 * Companion to `set_page_module_content` (which only edits unsynced
 * placements) and `fork_placement_content` (which detaches a synced
 * placement before editing).
 */

import { execute } from "@caelo-cms/query-api";
import { setContentInstanceValuesToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setContentInstanceValuesTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetContentInstanceValuesToolInput
> = {
  name: "set_content_instance_values",
  description:
    "Edit a content_instance's values. BLAST RADIUS: this update propagates to EVERY placement bound to this content_instance with sync_mode='synced'. " +
    "Confirm placementCount via get_content_instance or list_content_instances BEFORE calling this if you're unsure. " +
    "For 'edit only this page's text', use set_page_module_content or fork_placement_content+set_page_module_content instead. " +
    "`values` fully replaces existing values (zero-merge); read first via get_content_instance if you need to preserve other fields. " +
    "Optional `slug` and `displayName` rename the instance in the same write.",
  schema: setContentInstanceValuesToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "values"],
    properties: {
      id: { type: "string", format: "uuid" },
      values: { type: "object", additionalProperties: true },
      expectedVersion: { type: "integer", minimum: 0 },
      slug: {
        type: ["string", "null"],
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      },
      displayName: { type: ["string", "null"], minLength: 1, maxLength: 128 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "content_instances.set_values",
      input,
    );
    if (!r.ok) {
      return {
        ok: false,
        content: `content_instances.set_values failed: ${describeError(r.error)}`,
      };
    }
    const { placementCount, version } = r.value as { placementCount: number; version: number };
    return {
      ok: true,
      content: `content_instance ${input.id} updated to v${version}. ${placementCount === 0 ? "Orphan — no placements affected." : `Propagated to ${placementCount} placement(s).`}`,
    };
  },
};
