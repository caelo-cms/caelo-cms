// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — `add_module_to_layout`. Reaches every page on every template
 * bound to the layout in one call. Higher blast radius than
 * add_module_to_template (which only spans one template's pages); use
 * for true site-wide chrome (header / footer / nav). The system prompt
 * disambiguates: page-only → add_module_to_page, template-wide →
 * add_module_to_template, site-wide → this tool.
 *
 * Handler chain:
 *   1. layouts.get(slug)     → resolve to layoutId; verify block exists.
 *   2. modules.create        → make the module once.
 *   3. layout_modules.get    → read current moduleIds for the block.
 *   4. layout_modules.set    → splice + persist.
 */

import { execute } from "@caelo/query-api";
import { addModuleToLayoutToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface LayoutDetail {
  id: string;
  slug: string;
  blocks: { name: string; displayName: string; position: number }[];
}

function slugify(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stem = base.length > 0 ? base : "module";
  return `${stem}-${Date.now().toString(36)}`;
}

export const addModuleToLayoutTool: ToolDefinitionWithHandler<
  import("@caelo/shared").AddModuleToLayoutToolInput
> = {
  name: "add_module_to_layout",
  description:
    "Create a new module and attach it to a LAYOUT block (header / footer / nav). " +
    "The chrome reaches every page on every template bound to the layout. " +
    'Use ONLY for site-wide chrome ("a footer on every page", "a global header banner"). ' +
    "For template-wide changes use add_module_to_template; for one page use add_module_to_page. " +
    'Common layoutSlug is "site-default"; "bare" is the no-chrome layout.',
  schema: addModuleToLayoutToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["layoutSlug", "blockName", "position", "displayName", "html"],
    properties: {
      layoutSlug: { type: "string", minLength: 1, maxLength: 120 },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: {
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      js: { type: "string", maxLength: 50_000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", {
      slug: input.layoutSlug,
    });
    if (!got.ok) {
      return { ok: false, content: `layouts.get failed: ${describeError(got.error)}` };
    }
    const layout = (got.value as { layout: LayoutDetail | null }).layout;
    if (!layout) {
      return { ok: false, content: `layout "${input.layoutSlug}" not found` };
    }
    const block = layout.blocks.find((b) => b.name === input.blockName);
    if (!block) {
      const allowed = layout.blocks.map((b) => b.name).join(", ");
      return {
        ok: false,
        content: `block "${input.blockName}" not on layout "${input.layoutSlug}". Available: ${allowed}`,
      };
    }
    const slug = slugify(input.displayName);
    const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
      slug,
      displayName: input.displayName,
      html: input.html,
      css: input.css ?? "",
      js: input.js ?? "",
    });
    if (!created.ok) {
      return { ok: false, content: `modules.create failed: ${describeError(created.error)}` };
    }
    const newModuleId = (created.value as { moduleId: string }).moduleId;

    const existingRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "layout_modules.get",
      { layoutId: layout.id, blockName: input.blockName },
    );
    if (!existingRes.ok) {
      return {
        ok: false,
        content: `layout_modules.get failed: ${describeError(existingRes.error)}`,
      };
    }
    const existingIds = (existingRes.value as { moduleIds: string[] }).moduleIds;
    const insertIdx =
      input.position === "top"
        ? 0
        : input.position === "bottom"
          ? existingIds.length
          : Math.min(input.position, existingIds.length);
    const nextIds = [
      ...existingIds.slice(0, insertIdx),
      newModuleId,
      ...existingIds.slice(insertIdx),
    ];
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.set", {
      layoutId: layout.id,
      blockName: input.blockName,
      moduleIds: nextIds,
    });
    if (!setRes.ok) {
      return {
        ok: false,
        content: `layout_modules.set failed: ${describeError(setRes.error)}`,
      };
    }
    return {
      ok: true,
      content: `module ${newModuleId} (slug=${slug}) added to layout "${layout.slug}" block "${input.blockName}" at position ${insertIdx}; chrome now reaches every page on every template bound to this layout`,
    };
  },
};
