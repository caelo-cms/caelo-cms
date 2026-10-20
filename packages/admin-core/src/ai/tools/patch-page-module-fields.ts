// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — AI tool: patch_page_module_fields. Changes individual text values
 * of ONE placement (a heading, one list item, one link label) without
 * re-sending the placement's whole value set. Wraps
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
  description:
    "Change individual TEXT values of ONE module placement — a heading, one bullet of a text-list, one link label of a link-list — and leave every other value of that placement untouched. " +
    "Use this for targeted wording fixes ('the hero says Welcom, fix it', 'rename the second menu item to Pricing', or a reference chip naming `placement=(blockName, position), field=…[index]`): you send only the changed values instead of the placement's whole contentValues. " +
    "`text` is plain text exactly as it should read (it is HTML-escaped for you — never send markup). `index` addresses a `text-list` item or a `link-list` entry (its label). Several edits of one placement go in one call (all or none). " +
    "Use `set_page_module_content` (NOT this tool) to replace a placement's values wholesale or to set non-text fields (images, links' targets, nested modules); `set_page_module_content_many` for passes across several placements; `edit_module` for structure. " +
    "SYNCED placements (content shared with other pages) are refused with guidance: `fork_placement_content` to detach first, or `set_content_instance_values` to change it everywhere. " +
    'Typical call: `{pageId: "…", blockName: "content", position: 0, edits: [{field: "hero_title", text: "Welcome"}, {field: "nav_items", index: 1, text: "Pricing"}]}`.',
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
            index: { type: "integer", minimum: 0 },
            text: { type: "string", maxLength: 10000 },
          },
        },
      },
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
        .map((e) => (e.index !== undefined ? `${e.field}[${e.index}]` : e.field))
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
