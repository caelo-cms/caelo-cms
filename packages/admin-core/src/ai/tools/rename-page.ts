// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: rename_page. Updates ONLY `pages.name` (the internal editor
 * label). The HTML <title> and the URL slug stay put — no redirect,
 * no SEO impact. When a user says "rename to X", they almost always
 * mean this; the system prompt's tool-guidance steers ambiguous
 * requests to ask the user before touching the URL.
 */

import { execute } from "@caelo/query-api";
import { renamePageToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const renamePageTool: ToolDefinitionWithHandler<
  import("@caelo/shared").RenamePageToolInput
> = {
  name: "rename_page",
  description:
    "Rename a page's internal label only (the friendly name shown in the page picker / breadcrumbs). " +
    "Does NOT change the HTML <title> tag or the URL slug. Use this when the user says 'rename'. " +
    "If the user wants the browser tab / SERP title to change, call `set_page_title`. " +
    "If the user wants the URL to change, call `change_page_slug`. When ambiguous, ask first.",
  schema: renamePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "newName"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      newName: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.update", {
      pageId: input.pageId,
      name: input.newName,
    });
    if (!r.ok) return { ok: false, content: `pages.update failed: ${describeError(r.error)}` };
    return {
      ok: true,
      content: `page ${input.pageId} renamed to "${input.newName}" — URL and <title> unchanged`,
    };
  },
};
