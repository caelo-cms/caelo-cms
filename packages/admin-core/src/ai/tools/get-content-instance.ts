// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: get_content_instance. Fetch one content_instance
 * row + the list of placements that reference it. Use this to confirm
 * the blast radius of a `set_content_instance_values` edit before
 * committing.
 */

import { execute } from "@caelo-cms/query-api";
import { getContentInstanceToolInput } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const getContentInstanceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").GetContentInstanceToolInput
> = {
  name: "get_content_instance",
  description:
    "Fetch one content_instance by id. Returns the values + the list of placements (page slug + block + position + sync_mode) that bind to it. Use this to confirm blast radius before set_content_instance_values.",
  schema: getContentInstanceToolInput,
  inputSchema: z.toJSONSchema(getContentInstanceToolInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "content_instances.get", input);
    if (!r.ok) {
      // Miss → answer with a compact inventory INLINE so the model
      // corrects a stale/typo'd id in ONE step, not a list round-trip.
      const listR = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "content_instances.list",
        {},
      );
      const rows = listR.ok
        ? (
            listR.value as {
              instances: { id: string; moduleSlug: string; displayName: string | null }[];
            }
          ).instances.slice(0, 15)
        : [];
      const inventory =
        rows.length > 0
          ? `\nExisting instances (first ${rows.length}): ${rows.map((i) => `${i.id} (${i.moduleSlug}${i.displayName ? `, "${i.displayName}"` : ""})`).join("; ")}`
          : "\nNo content_instances exist (or are visible on this branch) yet — create one via create_content_instance or build_page.";
      return {
        ok: false,
        content: `content_instances.get failed: ${describeError(r.error)}${inventory}`,
      };
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
