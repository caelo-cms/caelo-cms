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

import { execute } from "@caelo-cms/query-api";
import { addModuleToLayoutToolInput, slugifyModuleName } from "@caelo-cms/shared";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface LayoutDetail {
  id: string;
  slug: string;
  blocks: { name: string; displayName: string; position: number }[];
}

export const addModuleToLayoutTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").AddModuleToLayoutToolInput
> = {
  name: "add_module_to_layout",
  description:
    "Create a new module and attach it to a LAYOUT block (header / footer / nav). " +
    "The chrome reaches every page on every template bound to the layout. " +
    'Use for site-wide chrome ("a footer on every page", "a global header banner"). ' +
    "For template-wide changes use add_module_to_template; for one page use add_module_to_page. " +
    'layoutSlug is the slug you set on create_layout (often "default" or "site-default"). ' +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). ' +
    'Quoted-string numbers like "0" fail validation — pass `0` not `"0"`.',
  // v0.6.0 W1 — state-aware: enumerate the layouts that exist + each
  // one's block names so the AI can pick a valid (layoutSlug, blockName)
  // pair without guessing. Avoids the recurring "block 'content' does
  // not exist" failure when the AI guesses a block name from prose
  // instead of reading the live layout shape.
  describe: (state) => {
    const lines: string[] = [
      "Create a new module and attach it to a LAYOUT block. The chrome reaches every page on every template bound to the layout.",
      'Use for site-wide chrome ("a footer on every page", "a global header banner"). For one page use add_module_to_page; for one template use add_module_to_template.',
    ];
    if (state.layouts.length === 0) {
      lines.push(
        "NO layouts exist on this site yet — this tool will fail. Call create_layout first.",
      );
    } else {
      lines.push("Available (layoutSlug, blockName) pairs:");
      for (const l of state.layouts) {
        const blocks = l.blocks.length > 0 ? l.blocks.map((b) => b.name).join("/") : "(no blocks)";
        lines.push(`- ${l.slug} → blocks: ${blocks}`);
      }
      lines.push(
        "Pick a (layoutSlug, blockName) pair from above — guessing a block name that doesn't appear in this list will fail validation.",
      );
    }
    lines.push(
      'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). Quoted-string numbers like "0" fail validation — pass `0` not `"0"`.',
    );
    return lines.join(" ");
  },
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
      // v0.5.21 — module field schema (v0.4.0 split). See edit_module
      // for the per-field shape; same validation rules apply here.
      fields: {
        type: "array",
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind", "label"],
          properties: {
            name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            kind: {
              type: "string",
              enum: ["text", "richtext", "url", "image", "number", "boolean", "link"],
            },
            label: { type: "string", minLength: 1, maxLength: 128 },
            default: {},
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // v0.11.4 (issue #76 follow-up) — cold-start gate.
    const gate = await checkColdStartGate(ctx, toolCtx, "add_module_to_layout");
    if (gate.blocked) return gate.gateResult!;

    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", {
      slug: input.layoutSlug,
    });
    if (!got.ok) {
      return { ok: false, content: `layouts.get failed: ${describeError(got.error)}` };
    }
    const layout = (got.value as { layout: LayoutDetail | null }).layout;
    if (!layout) {
      // v0.6.0 W3 — autoExecute list_layouts so AI sees the actual
      // available slugs without an extra round-trip.
      return {
        ok: false,
        content: `layout "${input.layoutSlug}" not found`,
        nextAction: {
          tool: "list_layouts",
          reason: "fetch the available layout slugs; the one passed does not match a live layout",
          autoExecute: true,
        },
      };
    }
    const block = layout.blocks.find((b) => b.name === input.blockName);
    if (!block) {
      const allowed = layout.blocks.map((b) => b.name).join(", ");
      return {
        ok: false,
        content: `block "${input.blockName}" not on layout "${input.layoutSlug}". Available: ${allowed}`,
        // Recovery suggests calling layouts.get for this layoutSlug
        // (the available block names came back in `allowed` already,
        // but we hint the AI to introspect the layout deeper if it
        // wants to choose a different block).
        nextAction: {
          tool: "list_layouts",
          reason: `pick blockName from [${allowed}] and retry — the layout has no block named "${input.blockName}"`,
        },
      };
    }
    const slug = slugifyModuleName(input.displayName);
    const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
      slug,
      displayName: input.displayName,
      html: input.html,
      css: input.css ?? "",
      js: input.js ?? "",
      ...(input.fields ? { fields: input.fields } : {}),
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
