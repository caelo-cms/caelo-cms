// SPDX-License-Identifier: MPL-2.0

/**
 * v0.9.13 — AI tool: `set_page_status`. Flips one page's status between
 * 'draft' and 'published'. Wraps the `pages.set_status` op which does
 * the dual-write (live row + latest branched snapshot patch) needed so
 * the change persists through Stage.
 *
 * For >1 page in a single ask ("publish all drafts", "draft these 4"),
 * prefer `set_pages_status_many` — saves N round-trips + N snapshots.
 */

import { execute } from "@caelo-cms/query-api";
import { setPageStatusToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPageStatusTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetPageStatusToolInput
> = {
  name: "set_page_status",
  description:
    "Flip ONE page's status between 'draft' and 'published'. " +
    "Drafts are LIVE-EDIT ONLY — visible in the editor's iframe + picker, but NOT shipped to Stage or Production. " +
    "Only `status: 'published'` pages reach deployed environments. " +
    "Status is sticky — other edits in this chat (title, slug, modules) preserve it; only this tool or the top-bar toggle in /edit changes it. " +
    "For >1 page in one ask (e.g. 'publish all drafts', 'draft these four'), prefer `set_pages_status_many` over multiple calls — one round-trip vs N.",
  schema: setPageStatusToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "status"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["draft", "published"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_status", input);
    if (!r.ok) {
      return { ok: false, content: `pages.set_status failed: ${describeError(r.error)}` };
    }
    return {
      ok: true,
      content: `page ${input.pageId} status set to ${input.status}`,
    };
  },
};
