// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: create_page. Creates a new page row with three distinct
 * identifiers — `name` (internal label), `title` (HTML <title>), and
 * `slug` (URL path). Wraps `pages.create`. The AI must pick a
 * template from the system prompt's All-pages block (each existing
 * page lists its template); we don't auto-pick a default.
 */

import { execute } from "@caelo/query-api";
import { createPageToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createPageTool: ToolDefinitionWithHandler<
  import("@caelo/shared").CreatePageToolInput
> = {
  name: "create_page",
  description:
    "Create a new page. Three identifiers — `name` (internal editor label), `title` (HTML <title> tag), `slug` (URL path). " +
    "If the user only mentions one (e.g. 'create About Us'), default `title` and `name` to the same value and slugify for the URL.",
  schema: createPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "title", "slug", "templateId"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 256 },
      title: { type: "string", minLength: 1, maxLength: 256 },
      slug: { type: "string", minLength: 1, maxLength: 120 },
      locale: { type: "string", minLength: 2, maxLength: 10 },
      templateId: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["draft", "published"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.create", input);
    if (!r.ok) return { ok: false, content: `pages.create failed: ${describeError(r.error)}` };
    const pageId = (r.value as { pageId: string }).pageId;
    return {
      ok: true,
      content: `page created: id=${pageId} name="${input.name}" title="${input.title}" slug=/${input.slug}`,
    };
  },
};
