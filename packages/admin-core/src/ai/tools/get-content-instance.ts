// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: get_content_instance. Fetch one content_instance
 * row + the list of placements that reference it. Use this to confirm
 * the blast radius of a `set_content_instance_values_many` edit before
 * committing.
 */

import { execute } from "@caelo-cms/query-api";
import { getContentInstanceToolInput } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const getContentInstanceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").GetContentInstanceToolInput
> = {
  name: "get_content_instance",
  description:
    "Fetch one content_instance, as this chat's draft sees it: values, placements (page path, block, position, sync_mode), parents showing it (instances' `module`/`module-list` fields, module defaults, shared lists) and every page it renders on. Check that blast radius before `set_content_instance_values_many` and before deleting (orphan = no placements AND no parents).",
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
          : "\nNo content_instances exist (or are visible on this branch) yet — create one via create_content_instances or build_page.";
      return toolError(
        r.error,
        `content_instances.get failed: ${describeError(r.error)}${inventory}`,
      );
    }
    const v = r.value as {
      instance: {
        id: string;
        moduleSlug: string;
        slug: string | null;
        displayName: string | null;
        values: Record<string, unknown>;
        version: number;
      };
      placements: { pagePath: string; blockName: string; position: number; syncMode: string }[];
      nestedParents: string[];
      parentModules: { moduleId: string; slug: string; field: string }[];
      parentLists: { listId: string; slug: string }[];
      renderedOn: { path: string }[];
      chromeLayouts: { slug: string }[];
      viaLists: { slug: string }[];
    };
    const { instance, placements } = v;
    const placementLines = placements
      .map((p) => `  - ${p.pagePath} · ${p.blockName}#${p.position} (${p.syncMode})`)
      .join("\n");
    // #1067 / #627 — a child shown by a parent (another instance, a module
    // default, a shared list) renders wherever that parent renders, so "no
    // placements" alone never means orphan, and the blast radius is the
    // pages it renders on, not its own placement count.
    const parents = [
      ...v.nestedParents.map((id) => `instance ${id} (module / module-list field)`),
      ...v.parentModules.map(
        (m) => `module ${m.slug} (${m.moduleId}) default of field "${m.field}"`,
      ),
      ...v.parentLists.map((l) => `shared list ${l.slug} (${l.listId})`),
    ];
    const shownPages = v.renderedOn.slice(0, 20).map((p) => p.path);
    const siteWide = [
      ...v.chromeLayouts.map((l) => `layout chrome of ${l.slug} (every page of that layout)`),
      ...v.viaLists.map((l) => `wherever shared list ${l.slug} renders`),
    ];
    const reach =
      `\nrenders on ${v.renderedOn.length} page(s)` +
      (shownPages.length > 0
        ? `: ${shownPages.join(", ")}${v.renderedOn.length > shownPages.length ? ", ..." : ""}`
        : "") +
      (siteWide.length > 0 ? `; also ${siteWide.join("; ")}` : "") +
      " — the blast radius of set_content_instance_values_many";
    return {
      ok: true,
      content:
        `content_instance ${instance.id} (module=${instance.moduleSlug}${instance.slug ? `, slug=${instance.slug}` : ""}) v${instance.version}\n` +
        `values: ${JSON.stringify(instance.values)}\n` +
        (placements.length > 0
          ? `bound to ${placements.length} placement(s):\n${placementLines}`
          : "bound to no placements of its own") +
        (parents.length > 0
          ? `\nshown inside ${parents.length} parent(s): ${parents.join("; ")} — NOT an orphan; deleting it is refused until it is removed from those parents`
          : placements.length === 0
            ? " and no parent (orphan — safe to delete)"
            : "") +
        (placements.length > 0 || parents.length > 0 ? reach : ""),
    };
  },
};
