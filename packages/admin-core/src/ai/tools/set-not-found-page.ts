// SPDX-License-Identifier: MPL-2.0

/**
 * 0284 (#802) — `set_not_found_page`. AI designates the page visitors see
 * on a broken link; the static build ships it as `/404.html`.
 */

import { execute } from "@caelo-cms/query-api";
import { type SetNotFoundPageToolInput, setNotFoundPageToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setNotFoundPageTool: ToolDefinitionWithHandler<SetNotFoundPageToolInput> = {
  name: "set_not_found_page",
  description:
    "Designate the site's 404 page (shown for every nonexistent URL).\n" +
    "USE WHEN the operator asks for an error/'page not found' page, or accepts your offer because the site status says no 404 page is designated (offer at the end of your turn; never build it unprompted inside another request).\n" +
    "CORE RULES:\n" +
    "- Build it like any page (`build_page`, the site's normal template so header/footer/theme apply; e.g. short 'Page not found' + links to homepage and main sections) -> PUBLISH (`set_pages_status_many`) -> call this with its id.\n" +
    "- Ships as /404.html with HTTP 404 for every unknown URL; NOT reachable at its own slug, noindex, not in the sitemap.\n" +
    "- ONE per site (replaces the previous); not the homepage.",
  schema: setNotFoundPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: {
        type: ["string", "null"],
        format: "uuid",
        description:
          "null clears the designation (the hosting provider's generic error page returns).",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages.set_not_found_page",
      input,
    );
    if (!res.ok) {
      return {
        ok: false,
        content: `pages.set_not_found_page failed: ${describeError(res.error)}`,
      };
    }
    const value = res.value as { pageId: string | null };
    return {
      ok: true,
      content:
        value.pageId === null
          ? "the 404 page designation is cleared — unknown URLs show the hosting provider's generic error page after the next publish."
          : `page ${value.pageId} is now the 404 page — after the next publish it is served for every unknown URL (status 404) as /404.html. Make sure the page is published.`,
      value,
    };
  },
};
