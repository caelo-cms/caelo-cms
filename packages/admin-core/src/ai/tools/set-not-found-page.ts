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
    "Designate the site's 404 page: the page visitors see when they open a URL that does not exist (broken link, typo, removed page). " +
    "Use when the operator asks for an error / 'page not found' page, or when the site status says the 404 page is not designated. " +
    "Build the page first like any other page (build_page with the site's normal template, so header, footer and theme apply; e.g. a short 'Page not found' message, a link back to the homepage and the main sections), PUBLISH it (set_pages_status_many), then call this with its id. " +
    "Publishing ships it as /404.html, served for every unknown URL with HTTP status 404 — it is NOT reachable at its own slug, is noindex and stays out of the sitemap. " +
    "Exactly ONE 404 page per site; calling this replaces the previous one. The homepage cannot be the 404 page. Pass pageId null to remove the designation (the hosting provider's generic error page returns).",
  schema: setNotFoundPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: {
        type: ["string", "null"],
        format: "uuid",
        description: "The page to use for unknown URLs, or null to clear the designation.",
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
