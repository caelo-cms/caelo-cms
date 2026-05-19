// SPDX-License-Identifier: MPL-2.0

/**
 * v0.9.13 — AI tool: `set_pages_status_many`. Bulk variant of
 * `set_page_status`. Flips N pages' status in one transaction with the
 * same dual-write contract (live row + latest branched snapshot patch).
 *
 * Per CLAUDE.md §11: bulk variants of routine ops save N×round-trips,
 * N×token cycles, and N×tool-result events in chat. Prefer this over
 * iterating `set_page_status` whenever the user names >1 page.
 */

import { execute } from "@caelo-cms/query-api";
import { setPagesStatusManyToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPagesStatusManyTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetPagesStatusManyToolInput
> = {
  name: "set_pages_status_many",
  description:
    "Flip up to 200 pages' status to the same value in one transaction. " +
    "Use for 'publish all drafts', 'draft these four pages', or any N>1 status flip. " +
    "Drafts are LIVE-EDIT ONLY — they're visible in the editor but NOT shipped to Stage or Production. " +
    "All-or-nothing: the single tx rolls back if any page fails (e.g. one of the ids is deleted or doesn't exist). " +
    "Prefer this over multiple `set_page_status` calls — one round-trip vs N, one audit row vs N. " +
    "For a single page, use `set_page_status` directly.",
  schema: setPagesStatusManyToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageIds", "status"],
    properties: {
      pageIds: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "string", format: "uuid" },
      },
      status: { type: "string", enum: ["draft", "published"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_status_many", input);
    if (!r.ok) {
      return { ok: false, content: `pages.set_status_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as { updatedCount: number };
    return {
      ok: true,
      content: `${v.updatedCount} page(s) set to ${input.status}`,
    };
  },
};
