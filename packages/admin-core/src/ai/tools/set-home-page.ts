// SPDX-License-Identifier: MPL-2.0

/**
 * 0184 — `set_home_page`. AI designates any page as the site homepage
 * instead of relying on a magic `home` slug.
 */

import { execute } from "@caelo-cms/query-api";
import { setHomePageToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import { stageReadinessSuffix } from "./_stage-readiness.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setHomePageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetHomePageToolInput
> = {
  name: "set_home_page",
  description:
    "Make a page the site homepage, served at `/` (any page; keeps its own slug; no magic `home` slug). Exactly ONE homepage — replaces the previous one.",
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
      content: `page ${value.pageId} is now the homepage — it serves at the site root (/).${await stageReadinessSuffix(ctx, toolCtx)}`,
      value,
    };
  },
};
