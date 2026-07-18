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
    "Create a new page-type template (a reusable HTML+CSS shell other pages bind to). " +
    "Use when the user wants a NEW page-type ('create a blog-post template', 'a landing-page layout'). " +
    "Do NOT use to create a one-off page — use `build_page` instead. " +
    "`layoutId` is OPTIONAL when site defaults define a default layout (see `## Site defaults` / get_site_defaults) — then omitting it binds to that default. Without a configured default, `layoutId` is REQUIRED: pick a UUID from `## Layouts on this site` / list_layouts (omitting it fails with a structured 'no defaults' error, no silent fallback). With ZERO layouts on the site, call create_layout first. " +
    'CRITICAL — block syntax: render slots in `html` MUST be <caelo-slot name="X"></caelo-slot> tags, ' +
    "NOT HTML comments like <!-- block:X -->. The composer ignores comment-style markers and the page " +
    "renders empty. Define block rows separately via the templates editor or " +
    "propose_update_template's `blocks` field — every block name needs a matching <caelo-slot> in html.",
  // 2026-07 — STATIC on purpose (prompt-cache): all layoutId states are
  // covered in the description above; live slugs stay in the volatile
  // context blocks + list_layouts.
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
      blocks: {
        type: "array",
        description:
          'Optional block-set metadata (same shape as create_layout). Omit it to auto-derive one block per <caelo-slot name="X"> in html (displayName = name). Pass it only to give a block a nicer displayName or an explicit position; every `name` MUST match a <caelo-slot> in html.',
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
