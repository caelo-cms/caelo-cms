// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: create_template. P18 — closes a CLAUDE.md §11 gap (the AI
 * couldn't create new page-types). Wraps `templates.create`. The op
 * resolves `layoutId` to `site_defaults.default_layout_id` when omitted,
 * so the AI only needs to pass slug + displayName + html + css for the
 * common case; it picks a non-default layout from list_layouts when the
 * user asks.
 *
 * Use when the user asks for a new page-type (e.g. "create a blog-post
 * template", "make a landing-page template"). Do NOT use to create a
 * single page — that's `build_page`. Templates are page-shape
 * definitions; pages are instances bound to a template.
 */

import { execute } from "@caelo-cms/query-api";
import { createTemplateToolInput } from "@caelo-cms/shared";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError, forwardNextAction } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createTemplateTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreateTemplateToolInput
> = {
  name: "create_template",
  description:
    "Create a template (reusable HTML+CSS shell pages bind to) for a page type, e.g. 'a blog-post template'. NOT for a one-off page (`build_page`).\n" +
    "CORE RULES:\n" +
    "- An ordinary template omits `pageType` (it joins the site's default page type). Pass `pageType` only with a slug `list_page_types` shows; never guess one (`page`, `article` …).\n" +
    "- A new KIND of content (news, products) is a page type first: `upsert_page_types_many` needs a template id -> create the template, then the type listing it (or pass an existing type's slug).\n" +
    "- `layoutId`: optional when a default layout exists (`get_site_defaults`; omitted -> that default); else REQUIRED, pick from `list_layouts` (omitting fails with 'no defaults'). Zero layouts -> `create_layout` first.\n" +
    '- Slots in `html` MUST be `<caelo-slot name="X"></caelo-slot>`, NOT comments like `<!-- block:X -->` (ignored -> page renders empty). Every block name needs a matching slot.',
  // Static on purpose (prompt cache): every layoutId state is covered in
  // the description; live layouts come from list_layouts.
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
      pageType: {
        type: "string",
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
        description:
          "Existing page type slug from `list_page_types`; the template joins its templates.",
      },
      blocks: {
        type: "array",
        description:
          "Omit to auto-derive one block per `<caelo-slot>` (displayName = name); pass only for nicer displayNames or explicit positions.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName", "position"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            position: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.create", input);
    if (!r.ok) {
      const next = forwardNextAction(r.error);
      return {
        ok: false,
        content: `templates.create failed: ${describeError(r.error)}`,
        ...(next ? { nextAction: next } : {}),
      };
    }
    const templateId = (r.value as { templateId: string }).templateId;
    return {
      ok: true,
      content: `template created: id=${templateId} slug=${input.slug} displayName="${input.displayName}"${await cssVarWarningSuffix(ctx, toolCtx, input.css)}`,
    };
  },
};
