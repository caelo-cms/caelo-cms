// SPDX-License-Identifier: MPL-2.0

/**
 * #917 / #918 — AI tool: patch_page_module_fields. Changes individual
 * values of ONE placement (a heading, one list item, a link's text or
 * target, an image) without re-sending the placement's whole value set. Wraps
 * `page_module_content.patch_fields`, the op Live Edit's in-place text
 * editing uses, so the AI and the operator write through the same path.
 */

import { execute } from "@caelo-cms/query-api";
import type { z } from "zod";
import { patchPageModuleFieldsInput } from "../../ops/content/page-module-patch.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const patchPageModuleFieldsTool: ToolDefinitionWithHandler<
  z.infer<typeof patchPageModuleFieldsInput>
> = {
  name: "patch_page_module_fields",
  description: [
    "Change individual values of ONE placement (a heading, one local-`list` entry's text or link, a `url`/`image` field); all other values stay untouched.",
    "USE FOR: targeted wording fixes ('fix Welcom in the hero', 'rename the 2nd menu item to Pricing', a chip naming `placement=(blockName, position), field=…[entry]`).",
    "DO NOT USE FOR: replacing placements' values wholesale or setting nested modules -> `set_page_module_content_many`; structure -> `update_modules_many`.",
    "CORE RULES:",
    "- Several edits of one placement go in one call (all or none).",
    "- SYNCED placement (content shared with other pages) needs `scope`: `everywhere` = every page showing it | `here` = detach this page first, change only it. Ask the operator when unclear.",
    'E.g. `{pageId, blockName:"content", position:0, edits:[{field:"hero_title", text:"Welcome"}, {field:"nav_items", item:"<entry id>", key:"label", text:"Pricing"}]}`',
  ].join("\n"),
  schema: patchPageModuleFieldsInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "blockName", "position", "edits"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      blockName: { type: "string", minLength: 1 },
      position: { type: "integer", minimum: 0 },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "text"],
          properties: {
            field: { type: "string", minLength: 1, maxLength: 200 },
            item: { type: "string", description: "Entry id in a local `list` field." },
            key: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,63}$",
              description: "Entry field, e.g. `label`, `text`, `link`.",
            },
            part: { type: "string", enum: ["href"], description: "Set a link field's target." },
            text: {
              type: "string",
              maxLength: 10000,
              description:
                "New value: plain text for text fields (HTML-escaped for you — never markup); path / https URL for `url`/`image` fields and link targets.",
            },
          },
        },
      },
      scope: { type: "string", enum: ["everywhere", "here"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const result = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "page_module_content.patch_fields",
      input,
    );
    if (result.ok) {
      const fields = input.edits
        .map((e) => (e.item !== undefined ? `${e.field}[${e.item}].${e.key}` : e.field))
        .join(", ");
      return {
        ok: true,
        content: `updated ${fields} for ${input.blockName}#${input.position} on page ${input.pageId}`,
      };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};
