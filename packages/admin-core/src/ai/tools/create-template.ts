// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: create_template. P18 — closes a CLAUDE.md §11 gap (the AI
 * couldn't create new page-types). Wraps `templates.create`. The op
 * resolves `layoutId` to `site_defaults.default_layout_id` when omitted,
 * so the AI only needs to pass slug + displayName + html + css for the
 * common case; it picks a non-default layout from `## Layouts on this
 * site` when the user asks.
 *
 * Use when the user asks for a new page-type (e.g. "create a blog-post
 * template", "make a landing-page template"). Do NOT use to create a
 * single page — that's `create_page`. Templates are page-shape
 * definitions; pages are instances bound to a template.
 */

import { execute } from "@caelo-cms/query-api";
import { createTemplateToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createTemplateTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreateTemplateToolInput
> = {
  name: "create_template",
  description:
    "Create a new page-type template (a reusable HTML+CSS shell other pages bind to). " +
    "Use when the user wants a NEW page-type ('create a blog-post template', 'a landing-page layout'). " +
    "Do NOT use to create a one-off page — use `create_page` instead. " +
    "`layoutId` is optional: omit it to bind to the site default layout (see `## Site defaults`); " +
    "pass a UUID from `## Layouts on this site` when the user asks for a non-default chrome.",
  schema: createTemplateToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "html"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 256 },
      html: { type: "string", minLength: 1 },
      css: { type: "string" },
      layoutId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.create", input);
    if (!r.ok) return { ok: false, content: `templates.create failed: ${describeError(r.error)}` };
    const templateId = (r.value as { templateId: string }).templateId;
    return {
      ok: true,
      content: `template created: id=${templateId} slug=${input.slug} displayName="${input.displayName}"`,
    };
  },
};
