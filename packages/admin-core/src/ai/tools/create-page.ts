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
import { checkColdStartGate } from "./_cold-start-gate.js";
import { describeError, forwardNextAction } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createPageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreatePageToolInput
> = {
  name: "create_page",
  description:
    "Create a new EMPTY page. **Prefer `build_page` when you already know the page's modules** — it creates the page AND places the full module list with content in one transaction (§11 bulk-first), instead of create_page + N× add_module_to_page. Three identifiers — `name` (internal editor label), `title` (HTML <title> tag), `slug` (URL path). " +
    "Slug must match `[a-z0-9][a-z0-9-]*` — for the homepage use `home` (NOT `/` or empty). For 'About Us' use `about`. " +
    "If the user only mentions one identifier (e.g. 'create About Us'), default `title` and `name` to that value and slugify for the URL. " +
    "`templateId` is OPTIONAL: omit it to use the site default template (see `## Site defaults` for the slug, `## Templates → layouts` for UUIDs of non-default templates). " +
    "v0.9.9 `status` policy — Drafts are LIVE-EDIT ONLY; Stage and Production ship only `status: 'published'` pages. " +
    "Set `status: 'published'` when the user is building the initial site (look at `## All pages on this site` — if it's empty or has zero `status=published` entries, the user is bootstrapping; ship the page live). " +
    "Set `status: 'draft'` when the user is adding a one-off page to an existing site (other published pages already exist) so they can review before shipping. " +
    "The user can flip status anytime via the top-bar toggle in /edit; this default is the AI's best guess of intent.",
  // v0.6.0 W1 — state-aware: `templateId` semantics mirror create_template.
  // Omitting it works only when site_defaults.default_template_id is set,
  // otherwise the op rejects. On a fresh install say so loudly so the AI
  // bootstraps instead of repeatedly failing the optional-templateId path.
  describe: (state) => {
    const lines: string[] = [
      "Create a new EMPTY page. Prefer `build_page` when you already know the page's modules — it creates the page AND places them with content in one transaction. Three identifiers — `name` (internal editor label), `title` (HTML <title> tag), `slug` (URL path).",
      "Slug must match `[a-z0-9][a-z0-9-]*` — for the homepage use `home` (NOT `/` or empty). For 'About Us' use `about`.",
      "If the user only mentions one identifier (e.g. 'create About Us'), default `title` and `name` to that value and slugify for the URL.",
      "v0.9.9 `status` policy — Drafts are LIVE-EDIT ONLY; Stage and Production ship only published pages. " +
        "Set `status: 'published'` when bootstrapping the site (zero published pages exist in `## All pages on this site`). " +
        "Set `status: 'draft'` when adding one-off pages to a site that already has published content (let the user review first). " +
        "The user can flip status via the top-bar toggle in /edit.",
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
    // v0.11.4 (issue #76 follow-up) — cold-start gate.
    const gate = await checkColdStartGate(ctx, toolCtx, "create_page");
    if (gate.blocked) return gate.gateResult!;

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
