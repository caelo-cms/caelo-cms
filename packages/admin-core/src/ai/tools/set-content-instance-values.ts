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
    "Edit a content_instance's values. **BLAST RADIUS = placementCount in `## Content Library`** — this propagates to EVERY placement bound with sync_mode='synced'. " +
    "**Read `## Content Library` first** to see the row's `purpose` + sample pages + placement count before editing. If the operator described an edit that should ONLY affect one page, this is the WRONG tool — use `set_page_module_content` (unsynced placements) or `fork_placement_content` first (synced placements that need to be detached). " +
    "`values` fully replaces existing values (zero-merge); read first via `get_content_instance` if you need to preserve other fields. " +
    "Optional metadata edits in the same write: `slug` + `displayName` (pass `null` to clear), and v0.12.0 `purpose` (rewrite the rationale when the operator's intent for this shared row has shifted — keeps `## Content Library` accurate for your future self).",
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
      purpose: { type: ["string", "null"], maxLength: 1000 },
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
