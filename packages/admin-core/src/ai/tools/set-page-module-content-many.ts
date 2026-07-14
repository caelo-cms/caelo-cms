// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — AI tool: set_page_module_content_many (bulk). Fills the
 * content values for N placements in ONE transaction. Run #15 fired the
 * singular 29× at 110K–556K input tokens per round-trip; per CLAUDE.md
 * §11 the bulk variant is the default for any multi-placement pass.
 */

import { execute } from "@caelo-cms/query-api";
import { pageModuleContentSetManySchema } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPageModuleContentManyTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").PageModuleContentSetManyInput
> = {
  name: "set_page_module_content_many",
  description:
    "Set content values for SEVERAL placements in ONE transaction — prefer this over multiple `set_page_module_content` calls whenever a content pass touches more than one placement (a whole page's text, the same fix across pages; §11 bulk-first). All-or-nothing: any invalid item aborts the whole batch (the error names `items[i]`, the placement, and for value problems the failing field) and nothing is written. " +
    "Each item is the exact `set_page_module_content` shape: `{pageId, blockName, position, contentValues}` with `contentValues` keyed by the module's declared field names; each fully replaces that placement's values. Items may span multiple pages. " +
    "Same UNSYNCED-only contract as the singular tool: a SYNCED placement in the batch aborts it with the fork/commit guidance — fork_placement_content that placement (or set_content_instance_values deliberately) and resend. " +
    "**When NOT to use:** when the page and its modules don't exist yet, `build_page` places modules WITH their content in one call — never build a page as add_module_to_page + set_page_module_content_many when one build_page call does both. For one placement the singular tool is fine. " +
    'Typical call: `{items: [{pageId: "…", blockName: "content", position: 0, contentValues: {hero_title: "…"}}, {pageId: "…", blockName: "content", position: 1, contentValues: {body: "…"}}]}`.',
  schema: pageModuleContentSetManySchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pageId", "blockName", "position", "contentValues"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            blockName: { type: "string", minLength: 1, maxLength: 80 },
            position: { type: "integer", minimum: 0 },
            contentValues: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "page_module_content.set_many",
      input,
    );
    if (!r.ok) {
      return {
        ok: false,
        content: `page_module_content.set_many failed (whole batch rolled back): ${describeError(r.error)}`,
      };
    }
    const { updated } = r.value as { updated: number };
    return {
      ok: true,
      content: `${updated} placement(s) updated in one transaction.`,
    };
  },
};
