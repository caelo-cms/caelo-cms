// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: create_content_instance. Mints a reusable
 * content_instance for a module. Pair with `set_placement_content` to
 * bind it to one or more placements with sync_mode='synced'.
 */

import { execute } from "@caelo-cms/query-api";
import { createContentInstanceToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createContentInstanceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreateContentInstanceToolInput
> = {
  name: "create_content_instance",
  description:
    "Create a new content_instance for a module. Use this when you want CONTENT to be reusable across multiple placements — bind the new instance to each placement via `set_placement_content({syncMode:'synced'})`. " +
    "For one-off page content, prefer set_page_module_content which auto-mints a private (unsynced) instance. " +
    "`values` is keyed by the module's declared field names ({{fieldName}} placeholders). " +
    "Optional `slug` gives the instance a human-readable handle (e.g. 'primary-cta') — must be kebab-case and unique per module.",
  schema: createContentInstanceToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId"],
    properties: {
      moduleId: { type: "string", format: "uuid" },
      slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      values: { type: "object", additionalProperties: true },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "content_instances.create",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `content_instances.create failed: ${describeError(r.error)}` };
    }
    const { contentInstanceId } = r.value as { contentInstanceId: string };
    return {
      ok: true,
      content: `content_instance ${contentInstanceId} created${input.slug ? ` (slug=${input.slug})` : ""}. Bind it to placements via set_placement_content.`,
    };
  },
};
