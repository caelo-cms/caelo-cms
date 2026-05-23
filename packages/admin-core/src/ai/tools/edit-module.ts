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
    "Edit ONE module's structure: HTML template, CSS, JS, displayName, or field schema. " +
    "v0.12.2 — pass module HTML with content baked in if that's natural (e.g. `<h1>Welcome</h1>`); " +
    "the server runs an extractor that walks the HTML, replaces literal content with `{{fieldName}}` placeholders, " +
    "and mints fields (h1->title, p->body, a->ctaHref+ctaLabel, img->image+imageAlt, button->buttonLabel). " +
    "The op result carries `extractedFields[]` so you can see the inferred names. " +
    "Alternatively, pre-templatise with `{{fieldName}}` placeholders + explicit `fields` array for control over field names. Mixing is fine — existing placeholders are preserved verbatim. " +
    "Field kinds now include `module` (single nested module ref, slot `{{>fieldName}}`) and `module-list` (array, slot `{{#fieldName}}…{{/fieldName}}`); values for those fields are `{ moduleId, contentInstanceId }` records. " +
    "Edits are CHAT-BRANCHED until publish. " +
    "Use this when changing structure, styling, layout, or the list of fields a module exposes. " +
    "DO NOT use this to change what a specific page shows in a field — use `set_page_module_content` for that. " +
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
