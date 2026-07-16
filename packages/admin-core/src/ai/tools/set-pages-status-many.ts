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
    "Flip page status to 'draft' or 'published' — the ONE status tool, for 1 page or 200 (pass a single-item `pageIds` array for one page; there is no separate set_page_status tool). " +
    "Use for 'publish this page', 'publish all drafts', 'draft these four pages', or any status flip. " +
    "Drafts are LIVE-EDIT ONLY — they're visible in the editor but NOT shipped to Stage or Production; only 'published' pages reach deployed environments. " +
    "Status is sticky — other edits in this chat (title, slug, modules) preserve it; only this tool or the top-bar toggle in /edit changes it. " +
    "One transaction. Ids that don't match a live page (deleted / wrong id) are SKIPPED, not an error; the result's `updatedCount` reports how many actually flipped — compare it to the number of ids you passed to detect skips. It fails only if NONE matched.",
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
