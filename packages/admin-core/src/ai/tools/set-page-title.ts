// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_page_title. Updates ONLY `pages.title` — the HTML
 * `<title>` tag rendered into `<head>`. Distinct from `rename_page`
 * (internal label) and `change_page_slug` (URL). No redirect.
 */

import { execute } from "@caelo-cms/query-api";
import { setPageTitleToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPageTitleTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetPageTitleToolInput
> = {
  name: "set_page_title",
  description:
    "Set the page's HTML <title> tag (the text shown in the browser tab and search-engine results). " +
    "URL stays the same; no redirect created. Use this when the user mentions 'browser tab', '<title>', or 'SERP'. " +
    "Use `rename_page` for the internal label and `change_page_slug` for the URL.",
  schema: setPageTitleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "newTitle"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      newTitle: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.update", {
      pageId: input.pageId,
      title: input.newTitle,
    });
    if (!r.ok) return { ok: false, content: `pages.update failed: ${describeError(r.error)}` };
    return {
      ok: true,
      content: `page ${input.pageId} <title> set to "${input.newTitle}"`,
    };
  },
};
