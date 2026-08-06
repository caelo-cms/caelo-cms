// SPDX-License-Identifier: MPL-2.0

/**
 * 0184 — `set_home_page`. AI designates any page as the site homepage
 * instead of relying on a magic `home` slug.
 */

import { execute } from "@caelo-cms/query-api";
import { setHomePageToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setHomePageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetHomePageToolInput
> = {
  name: "set_home_page",
  description:
    "Designate a page as the site homepage — it then serves at the site root `/`. " +
    "Use this instead of relying on a magic `home` slug; any page can be the homepage. The page keeps its own slug. " +
    "There is exactly ONE homepage — calling this replaces any previous designation.",
  schema: setHomePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_home_page", input);
    if (!res.ok) {
      return { ok: false, content: `pages.set_home_page failed: ${describeError(res.error)}` };
    }
    const value = res.value as { pageId: string };
    return {
      ok: true,
      content: `page ${value.pageId} is now the homepage — it serves at the site root (/).`,
      value,
    };
  },
};
