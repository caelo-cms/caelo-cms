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
    "Create a new EMPTY page. **Prefer `build_page` when you already know the page's modules** — it creates the page AND places the full module list with content in one transaction (§11 bulk-first), instead of create_page + N× add_module. Three identifiers — `name` (internal editor label), `title` (HTML <title> tag), `slug` (URL path). " +
    "Slug must match `[a-z0-9][a-z0-9-]*` — for the homepage use `home` (NOT `/` or empty). For 'About Us' use `about`. " +
    "If the user only mentions one identifier (e.g. 'create About Us'), default `title` and `name` to that value and slugify for the URL. " +
    "`templateId` is OPTIONAL when site defaults define a default template (see `## Site defaults` / get_site_defaults) — then omitting it uses that default. When no default is configured, `templateId` is REQUIRED: pick a UUID from `## Templates → layouts` / list_templates, or call set_site_defaults once. With ZERO templates on the site, bootstrap first (create_layout → create_template → set_site_defaults). " +
    "v0.9.9 `status` policy — Drafts are LIVE-EDIT ONLY; Stage and Production ship only `status: 'published'` pages. " +
    "Set `status: 'published'` when the user is building the initial site (look at `## All pages on this site` — if it's empty or has zero `status=published` entries, the user is bootstrapping; ship the page live). " +
    "Set `status: 'draft'` when the user is adding a one-off page to an existing site (other published pages already exist) so they can review before shipping. " +
    // 2026-07 — STATIC on purpose (prompt-cache): templateId semantics
    // are described for every state above; live slugs stay in the
    // volatile context blocks + list_templates.
    "The user can flip status anytime via the top-bar toggle in /edit; this default is the AI's best guess of intent.",
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
