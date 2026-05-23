// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: edit_module. Writes one module's HTML/CSS/JS, displayName, or
 * field schema. Modules are the *structural* layer (CMS_REQUIREMENTS §3.1)
 * — edits land on main immediately and propagate to every page using the
 * module.
 *
 * v0.4.0 — module HTML is a TEMPLATE referencing fields as `{{name}}`.
 * The per-page content that fills those placeholders lives on each page
 * placement (see `set_page_module_content`). Use `edit_module` for code /
 * styling / field-schema changes that should affect every page using the
 * module. Use `set_page_module_content` to change what a specific page
 * shows in those fields.
 */

import { execute } from "@caelo-cms/query-api";
import { editModuleToolInput } from "@caelo-cms/shared";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const editModuleTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").EditModuleToolInput
> = {
  name: "edit_module",
  description:
    "Edit ONE module's structure: HTML template, fields, CSS, JS, displayName, description, or kind. " +
    "**AUTHOR EXPLICITLY (v0.12.0+):** pass `html` with `{{fieldName}}` placeholders + an explicit `fields[]` array with semantic snake_case names (`hero_title`, `primary_cta_href`, `nav_items`), NOT a literal-content fallback. The operator says 'fix the homepage hero copy'; YOU translate that to the right field names. Field names like `cta2label2` or `spanText` are wrong — they leak the extractor heuristic. " +
    "**Field kinds (v0.12.0):** `text`, `richtext`, `url`, `image`, `number`, `boolean`, `link` (primitives); `text-list` (array of strings, slot `{{#field}}…{{.}}…{{/field}}`); `link-list` (array of `{label, href}`, slot `{{#field}}…{{label}}…{{href}}…{{/field}}` — use for menus, footer columns); `module` (single nested module, slot `{{>field}}`); `module-list` (array of nested modules, slot `{{#field}}…{{/field}}`). " +
    "**Lists are lists, not numbered scalars.** A menu with 10 items is ONE `link-list` field with 10 elements — never `label1`, `label2`, …, `label10`. A tag cloud is ONE `text-list`. Cards with rich per-item structure use `module-list` pointing at a sub-module. " +
    "**Update description + kind when the module's purpose drifts.** The `## Modules` block exposes them to your future self; stale descriptions hurt your own decision-making. " +
    "**Legacy fallback only:** if you pass HTML with literal content and NO `fields[]`, a server-side extractor mints heuristic field names — useful for one-shot drafts but the result hurts the `## Modules` block. Treat it as a fallback, not the default path. " +
    "Edits are CHAT-BRANCHED until publish. " +
    "Use this for structure, styling, fields list, or `description`/`kind` updates. " +
    "DO NOT use this to change what one page shows — use `set_page_module_content` (per-page content) or `set_content_instance_values` (shared content) for that. " +
    "Prefer `update_modules_many` when targeting > 1 module. " +
    "DO NOT use for page metadata (`update_pages_many` / `set_page_title` / `change_page_slug`) or template-level edits (`propose_update_template`).",
  schema: editModuleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId"],
    properties: {
      moduleId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      description: { type: "string", maxLength: 1000 },
      kind: {
        type: "string",
        enum: ["chrome", "hero", "content", "cta", "utility"],
      },
      html: { type: "string" },
      css: { type: "string" },
      js: { type: "string" },
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
              enum: [
                "text",
                "richtext",
                "url",
                "image",
                "number",
                "boolean",
                "link",
                "text-list",
                "link-list",
                "module",
                "module-list",
              ],
            },
            label: { type: "string", minLength: 1, maxLength: 128 },
            default: {},
            allowedModuleSlugs: { type: "array", items: { type: "string" } },
            min: { type: "integer", minimum: 0 },
            max: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.update", input);
    if (result.ok) {
      // v0.12.2 — surface the extractor's inferred fields when present
      // so the AI's next turn sees the auto-minted names verbatim.
      const value = result.value as {
        extractedFields?: { name: string; kind: string }[];
      };
      const extracted = value.extractedFields ?? [];
      if (extracted.length > 0) {
        const list = extracted.map((f) => `${f.name} (${f.kind})`).join(", ");
        return {
          ok: true,
          content: `module ${input.moduleId} updated. Extractor inferred ${extracted.length} field(s): ${list}. Rename via a follow-up edit_module with explicit \`fields\`.`,
        };
      }
      return { ok: true, content: `module ${input.moduleId} updated` };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};
