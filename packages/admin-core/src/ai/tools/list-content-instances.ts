// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: list_content_instances. Browse the content
 * library. Returns each row's `placementCount` so the AI sees the
 * blast-radius of editing a shared instance without a per-row
 * `get_content_instance` round-trip.
 *
 * Typical AI flow when the operator says "edit the contact info on
 * every page that has it":
 *   1. list_content_instances({ search: "contact" }) — find the
 *      shared instance (placementCount > 1).
 *   2. set_content_instance_values({ id, values: {...} }) — single
 *      write propagates to every placement.
 */

import { execute } from "@caelo-cms/query-api";
import { listContentInstancesToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const listContentInstancesTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ListContentInstancesToolInput
> = {
  name: "list_content_instances",
  description:
    "List content_instances rows — the values that fill module placeholders on pages. " +
    "Filter by module (`moduleId`), slug, free-text search across slug+displayName, or page (`pageId` returns instances used on a specific page). " +
    "Each row carries `placementCount` (count of pages bound to it) so you can tell at a glance which instances are SHARED across pages — editing those propagates to every placement. " +
    "Use this BEFORE set_content_instance_values to confirm blast radius.",
  schema: listContentInstancesToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      moduleId: { type: "string", format: "uuid" },
      slug: { type: "string", minLength: 1, maxLength: 64 },
      search: { type: "string", minLength: 1, maxLength: 128 },
      pageId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "content_instances.list", input);
    if (!r.ok) {
      return { ok: false, content: `content_instances.list failed: ${describeError(r.error)}` };
    }
    const { instances } = r.value as {
      instances: {
        id: string;
        moduleSlug: string;
        slug: string | null;
        displayName: string | null;
        placementCount: number;
      }[];
    };
    if (instances.length === 0) {
      return { ok: true, content: "No content_instances match. Call create_content_instance to mint one." };
    }
    const lines = instances.map(
      (i) =>
        `- ${i.id}  module=${i.moduleSlug}${i.slug ? ` slug=${i.slug}` : ""}${i.displayName ? ` "${i.displayName}"` : ""}  placements=${i.placementCount}`,
    );
    return { ok: true, content: `${instances.length} content_instance(s):\n${lines.join("\n")}` };
  },
};
