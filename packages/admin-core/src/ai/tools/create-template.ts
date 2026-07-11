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
    "Do NOT use to create a one-off page — use `create_page` instead. " +
    "`layoutId` is optional: omit it to bind to the site default layout (see `## Site defaults`); " +
    "pass a UUID from `## Layouts on this site` when the user asks for a non-default chrome. " +
    'CRITICAL — block syntax: render slots in `html` MUST be <caelo-slot name="X"></caelo-slot> tags, ' +
    "NOT HTML comments like <!-- block:X -->. The composer ignores comment-style markers and the page " +
    "renders empty. Define block rows separately via the templates editor or " +
    "propose_update_template's `blocks` field — every block name needs a matching <caelo-slot> in html.",
  // v0.6.0 W1 — state-aware: `layoutId` semantics depend on whether
  // site_defaults is configured. On a fresh install where defaults is
  // empty, omitting layoutId yields a "no defaults" structured error
  // instead of falling back silently; the AI should bootstrap via
  // create_layout + set_site_defaults first OR pass an explicit
  // layoutId on every call. The static description lies in that state.
  describe: (state) => {
    const lines: string[] = [
      "Create a new page-type template (a reusable HTML+CSS shell other pages bind to).",
      "Use when the user wants a NEW page-type ('create a blog-post template', 'a landing-page layout').",
      "Do NOT use to create a one-off page — use `create_page` instead.",
    ];
    if (state.siteDefaults && state.layouts.length > 0) {
      lines.push(
        `\`layoutId\` is optional: omit it to bind to the site default layout "${state.siteDefaults.defaultLayoutSlug}"; ` +
          `pass a UUID from \`## Layouts on this site\` when the user asks for a non-default chrome (available slugs: ${state.layouts.map((l) => l.slug).join(", ")}).`,
      );
    } else if (state.layouts.length > 0) {
      lines.push(
        `\`layoutId\` is REQUIRED on this site — site_defaults has no default_layout configured. ` +
          `Pick a UUID from \`## Layouts on this site\` (available slugs: ${state.layouts.map((l) => l.slug).join(", ")}). ` +
          `Or call set_site_defaults first so future templates can omit layoutId.`,
      );
    } else {
      lines.push(
        "`layoutId` will fail validation on this site — there are NO layouts yet. " +
          "Call create_layout first to make a layout with header/content/footer blocks, then create_template referencing it, then set_site_defaults.",
      );
    }
    lines.push(
      'CRITICAL — block syntax: render slots in `html` MUST be <caelo-slot name="X"></caelo-slot> tags, ' +
        "NOT HTML comments like <!-- block:X -->. The composer ignores comment-style markers and the page renders empty.",
    );
    return lines.join(" ");
  },
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
