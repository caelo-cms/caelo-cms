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
  description:
    "Change individual values of ONE module placement — a heading, one entry's text or link target in a local `list` field, a `url` field, an `image` field — and leave every other value of that placement untouched. " +
    "Use this for targeted wording fixes ('the hero says Welcom, fix it', 'rename the second menu item to Pricing', or a reference chip naming `placement=(blockName, position), field=…[entry]`): you send only the changed values instead of the placement's whole contentValues. " +
    '`text` is the new value: plain text for text fields (it is HTML-escaped for you — never send markup), a path / https URL for `url` / `image` fields and link targets. For a local `list` field, `item` is the entry id and `key` the entry field (e.g. `label`, `text`, `link`); `part: "href"` sets a link field\'s target. Several edits of one placement go in one call (all or none). ' +
    "Use `set_page_module_content` (NOT this tool) to replace a placement's values wholesale or to set nested modules; `set_page_module_content_many` for passes across several placements; `edit_module` for structure. " +
    'SYNCED placements (content shared with other pages) need `scope`: `"everywhere"` changes it on every page that shows it, `"here"` detaches this page first and changes only it — ask the operator which they mean when it is not clear. ' +
    'Typical call: `{pageId: "…", blockName: "content", position: 0, edits: [{field: "hero_title", text: "Welcome"}, {field: "nav_items", item: "<entry id>", key: "label", text: "Pricing"}]}`.',
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
            item: { type: "string", description: "Entry id of a local list field." },
            key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            part: { type: "string", enum: ["href"] },
            text: { type: "string", maxLength: 10000 },
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
