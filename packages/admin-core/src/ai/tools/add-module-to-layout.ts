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
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import {
  findUnrenderableLayoutFields,
  unrenderableLayoutFieldsError,
} from "./_layout-module-fields.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
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
    "**CONTENT: layout chrome renders from field DEFAULTS.** A layout placement has NO content_instance binding, " +
    "so any `{{field}}` you put in the HTML must have its value in that field's `default` (e.g. " +
    '`{name:"copyright",kind:"text",label:"Copyright",default:"© 2026 …"}`, a footer nav as a `link-list` with a ' +
    "`default` array of {label,href}). Do NOT use create_content_instance / set_placement_content here — those bind " +
    "PAGE placements only and will NOT fill layout chrome. Author static text inline or as field defaults. " +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). ' +
    'Prefer a bare integer (`0`, not `"0"`) — quoted/over-quoted forms are normalized at the boundary, not rejected.',
  // v0.6.0 W1 — state-aware: enumerate the layouts that exist + each
  // one's block names so the AI can pick a valid (layoutSlug, blockName)
  // pair without guessing. Avoids the recurring "block 'content' does
  // not exist" failure when the AI guesses a block name from prose
  // instead of reading the live layout shape.
  describe: (state) => {
    const lines: string[] = [
      "Create a new module and attach it to a LAYOUT block. The chrome reaches every page on every template bound to the layout.",
      'Use for site-wide chrome ("a footer on every page", "a global header banner"). For one page use add_module_to_page; for one template use add_module_to_template.',
      "CONTENT: layout chrome has no content_instance binding — every `{{field}}` must carry its value in the field `default` (a footer nav is a `link-list` default; copyright is a `text` default). Do NOT use create_content_instance/set_placement_content here.",
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
      'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). Prefer a bare integer (`0`, not `"0"`) — quoted/over-quoted forms are normalized at the boundary, not rejected.',
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
      // issue #106 (step-13 round-4) — accept the same description/kind/type
      // metadata as add_module_to_page. The AI authors layout chrome with the
      // identical pattern it uses for page modules (CLAUDE.md §1A); omitting
      // these here while keeping additionalProperties:false rejected that
      // pattern with `unrecognized_keys`. See `_module-fields-schema.ts`.
      ...MODULE_META_JSON_SCHEMA_PROPS,
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT },
      // issue #106 — shared field schema (full kind enum incl. list +
      // nested-module kinds). A footer nav is a `link-list` field per
      // CLAUDE.md §1A; the old restricted 7-primitive enum made that
      // unrepresentable, so the provider could not emit a valid footer-nav
      // call and silently ended the turn. See `_module-fields-schema.ts`.
      fields: MODULE_FIELDS_JSON_SCHEMA,
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // issue #106 (step-13 round-5) — chrome renders from field defaults only
    // (layout placements have no content_instance binding). This is pure input
    // validation, so it runs FIRST — fail fast before any DB round-trip when a
    // declared field can't render from a default, so the AI re-authors with
    // defaults instead of shipping raw `{{…}}` site-wide and (as observed)
    // wrongly reaching for content_instances.
    const unrenderable = findUnrenderableLayoutFields(input.fields);
    if (unrenderable.length > 0) {
      return {
        ok: false,
        content: unrenderableLayoutFieldsError("add_module_to_layout", "layout", unrenderable),
      };
    }

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
      // issue #106 — forward the decision-support metadata so layout chrome
      // lands in `## Modules` with the same context page modules carry.
      // modules.create derives `type` from displayName when omitted.
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
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
      content: `module ${newModuleId} (slug=${slug}) added to layout "${layout.slug}" block "${input.blockName}" at position ${insertIdx}; chrome now reaches every page on every template bound to this layout${await cssVarWarningSuffix(ctx, toolCtx, input.css)}${await designGuardSuffix(ctx, toolCtx, { css: input.css, displayName: input.displayName, kind: input.kind, type: input.type })}`,
    };
  },
};
