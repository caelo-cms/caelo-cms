// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: get_content_instance. Fetch one content_instance
 * row + the list of placements that reference it. Use this to confirm
 * the blast radius of a `set_content_instance_values` edit before
 * committing.
 */

import { execute } from "@caelo-cms/query-api";
import { getContentInstanceToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const getContentInstanceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").GetContentInstanceToolInput
> = {
  name: "get_content_instance",
  description:
    "Fetch one content_instance by id. Returns the values + the list of placements (page slug + block + position + sync_mode) that bind to it. Use this to confirm blast radius before set_content_instance_values.",
  schema: getContentInstanceToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "content_instances.get", input);
    if (!r.ok) {
      return { ok: false, content: `content_instances.get failed: ${describeError(r.error)}` };
    }
    const { instance, placements } = r.value as {
      instance: {
        id: string;
        moduleSlug: string;
        slug: string | null;
        displayName: string | null;
        values: Record<string, unknown>;
        version: number;
      };
      placements: { pageSlug: string; blockName: string; position: number; syncMode: string }[];
    };
    const placementLines = placements
      .map((p) => `  - ${p.pageSlug} · ${p.blockName}#${p.position} (${p.syncMode})`)
      .join("\n");
    return {
      ok: true,
      content:
        `content_instance ${instance.id} (module=${instance.moduleSlug}${instance.slug ? `, slug=${instance.slug}` : ""}) v${instance.version}\n` +
        `values: ${JSON.stringify(instance.values)}\n` +
        (placements.length > 0
          ? `bound to ${placements.length} placement(s):\n${placementLines}`
          : "bound to no placements (orphan — safe to delete)"),
    };
  },
};
