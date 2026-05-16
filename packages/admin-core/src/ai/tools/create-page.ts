// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: create_page. Creates a new page row with three distinct
 * identifiers — `name` (internal label), `title` (HTML <title>), and
 * `slug` (URL path). Wraps `pages.create`. P18: `templateId` is
 * OPTIONAL — when omitted, the underlying op resolves to
 * `site_defaults.default_template_id`, so the AI can create a "homepage
 * on the default template" with one tool call.
 */

import { execute } from "@caelo-cms/query-api";
import { createPageToolInput } from "@caelo-cms/shared";
import { describeError, forwardNextAction } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createPageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreatePageToolInput
> = {
  name: "create_page",
  description:
    "Create a new page. Three identifiers — `name` (internal editor label), `title` (HTML <title> tag), `slug` (URL path). " +
    "Slug must match `[a-z0-9][a-z0-9-]*` — for the homepage use `home` (NOT `/` or empty). For 'About Us' use `about`. " +
    "If the user only mentions one identifier (e.g. 'create About Us'), default `title` and `name` to that value and slugify for the URL. " +
    "`templateId` is OPTIONAL: omit it to use the site default template (see `## Site defaults` for the slug, `## Templates → layouts` for UUIDs of non-default templates).",
  // v0.6.0 W1 — state-aware: `templateId` semantics mirror create_template.
  // Omitting it works only when site_defaults.default_template_id is set,
  // otherwise the op rejects. On a fresh install say so loudly so the AI
  // bootstraps instead of repeatedly failing the optional-templateId path.
  describe: (state) => {
    const lines: string[] = [
      "Create a new page. Three identifiers — `name` (internal editor label), `title` (HTML <title> tag), `slug` (URL path).",
      "Slug must match `[a-z0-9][a-z0-9-]*` — for the homepage use `home` (NOT `/` or empty). For 'About Us' use `about`.",
      "If the user only mentions one identifier (e.g. 'create About Us'), default `title` and `name` to that value and slugify for the URL.",
    ];
    if (state.siteDefaults && state.templates.length > 0) {
      lines.push(
        `\`templateId\` is OPTIONAL: omit it to use the site default template "${state.siteDefaults.defaultTemplateSlug}"; ` +
          `pass a non-default template UUID when needed (available slugs: ${state.templates.map((t) => t.slug).join(", ")}).`,
      );
    } else if (state.templates.length > 0) {
      lines.push(
        `\`templateId\` is REQUIRED on this site — site_defaults has no default_template configured. ` +
          `Pick a UUID from \`## Templates → layouts\` (available slugs: ${state.templates.map((t) => t.slug).join(", ")}). ` +
          `Or call set_site_defaults to make future create_page calls accept an omitted templateId.`,
      );
    } else {
      lines.push(
        "`templateId` will fail validation — there are NO templates on this site yet. " +
          "Bootstrap first: create_layout, create_template referencing it, set_site_defaults; THEN create_page.",
      );
    }
    return lines.join(" ");
  },
  schema: createPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "title", "slug"],
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
    if (!r.ok) {
      const next = forwardNextAction(r.error);
      return {
        ok: false,
        content: `pages.create failed: ${describeError(r.error)}`,
        ...(next ? { nextAction: next } : {}),
      };
    }
    const pageId = (r.value as { pageId: string }).pageId;
    return {
      ok: true,
      content: `page created: id=${pageId} name="${input.name}" title="${input.title}" slug=/${input.slug}`,
    };
  },
};
