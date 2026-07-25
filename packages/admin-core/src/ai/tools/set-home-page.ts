// SPDX-License-Identifier: MPL-2.0

/**
 * 0184 — `set_home_page`. AI designates any page as the site homepage
 * (per locale, the locale root) instead of relying on a magic `home` slug.
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
    "Designate a page as the site homepage — it then serves at the site root `/` (per locale, the locale root). " +
    "Use this instead of relying on a magic `home` slug; any page can be the homepage. The page keeps its own slug. " +
    "There is exactly ONE homepage per locale — calling this replaces any previous designation. " +
    "Pass `locale` only to set the root for a non-default locale (defaults to the page's own locale).",
  schema: setHomePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      locale: { type: "string", minLength: 2, maxLength: 10 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_home_page", input);
    if (!res.ok) {
      return { ok: false, content: `pages.set_home_page failed: ${describeError(res.error)}` };
    }
    const value = res.value as { pageId: string; locale: string };
    return {
      ok: true,
      content: `page ${value.pageId} is now the homepage for locale ${value.locale} — it serves at the site root (/).`,
      value,
    };
  },
};
