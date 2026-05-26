// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W4 (deferred) — `compose_page_from_spec` composite tool.
 *
 * Creates a page and attaches N modules to its content block in one
 * tool call. Replaces the AI-orchestrated chain:
 *   create_page → pages.get_with_modules → modules.create × N → pages.set_modules
 * with a single call whose handler runs the whole chain server-side.
 *
 * The AI naturally describes pages as "a title + a sequence of
 * sections"; this tool meets that mental model directly. Saves
 * ~(N+1)×round-trips of streaming + ~(N+1)×tool-result token spend.
 *
 * Per-section failure handling: if a single section fails to create
 * or attach, the tool reports a partial-success result with the IDs
 * that landed + the ones that didn't. The page itself is NOT rolled
 * back — the AI can re-call the tool with just the failed sections
 * (using add_module_to_page individually) to fix the gaps.
 */

import { execute } from "@caelo-cms/query-api";
import { composePageFromSpecToolInput } from "@caelo-cms/shared";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { describeError, forwardNextAction } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

function slugify(displayName: string, idx: number): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stem = base.length > 0 ? base : "section";
  // Include an index so two sections with the same displayName don't
  // collide on the unique slug constraint.
  return `${stem}-${idx}-${Date.now().toString(36)}`;
}

export const composePageFromSpecTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ComposePageFromSpecToolInput
> = {
  name: "compose_page_from_spec",
  description:
    "Composite: create a page and attach N section-modules in one call. " +
    "Pass {slug, name, title, sections:[{displayName, html, css?, js?}]} — the handler creates the page, " +
    "then creates and attaches each section as a module on the `content` block (override with `blockName`). " +
    "Saves N+1 round-trips vs. orchestrating create_page + add_module_to_page individually. " +
    "Use for 'compose a homepage with hero / features / testimonials' or any multi-section page where you know all sections up front. " +
    "Per-section failure: page is NOT rolled back; tool reports which sections landed + which didn't. " +
    "v0.9.9 `status` policy — Drafts are LIVE-EDIT ONLY; Stage and Production ship only `status: 'published'` pages. " +
    "Set `status: 'published'` when bootstrapping the site (check `## All pages on this site` — if zero `status=published` rows, the user is building from scratch; ship the page live). " +
    "Set `status: 'draft'` when adding a one-off page to a site that already has published content (user reviews before shipping). " +
    "The user can flip status anytime via the top-bar toggle in /edit.",
  describe: (state) => {
    const lines: string[] = [
      "Composite — create page + attach N sections in one call.",
      "Pass slug, name, title, and a sections array (each = {displayName, html, css?, js?}).",
    ];
    if (state.siteDefaults && state.templates.length > 0) {
      lines.push(
        `\`templateId\` optional — defaults to site default "${state.siteDefaults.defaultTemplateSlug}".`,
      );
    } else if (state.templates.length > 0) {
      lines.push(
        `\`templateId\` REQUIRED — site_defaults not configured. Pick a UUID from \`## Templates → layouts\` (slugs: ${state.templates.map((t) => t.slug).join(", ")}).`,
      );
    } else {
      lines.push(
        "Will fail — NO templates exist yet. Call bootstrap_site_scaffold first to set up layout + template + defaults.",
      );
    }
    lines.push(
      "Default blockName is `content`. Sections are placed in array order. Per-section failures are reported individually; the page is not rolled back.",
    );
    lines.push(
      "v0.6.1: SEO auto-fills inline — caller does NOT need a separate set_page_seo call. Override with `seo.metaDescription`, or skip via `seo.skipSeo:true` (e.g. for stubs).",
    );
    lines.push(
      "v0.9.9 `status` policy — Drafts are LIVE-EDIT ONLY; Stage and Production ship only published pages. " +
        "Set `status: 'published'` when bootstrapping the site (zero published pages exist in `## All pages on this site`). " +
        "Set `status: 'draft'` when adding one-off pages to a site that already has published content (let the user review first). " +
        "The user can flip status via the top-bar toggle in /edit.",
    );
    return lines.join(" ");
  },
  schema: composePageFromSpecToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "name", "title", "sections"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9][a-z0-9-]*$" },
      name: { type: "string", minLength: 1, maxLength: 256 },
      title: { type: "string", minLength: 1, maxLength: 256 },
      locale: { type: "string", minLength: 2, maxLength: 10 },
      templateId: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["draft", "published"] },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["displayName", "html"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            html: { type: "string", minLength: 1, maxLength: 50_000 },
            css: { type: "string", maxLength: 50_000 },
            js: { type: "string", maxLength: 50_000 },
          },
        },
      },
      // v0.6.1 — optional SEO. Composite auto-fills if omitted.
      seo: {
        type: "object",
        additionalProperties: false,
        properties: {
          metaDescription: { type: "string", minLength: 1, maxLength: 320 },
          ogImageAssetId: { type: "string", format: "uuid" },
          skipSeo: { type: "boolean" },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const blockName = input.blockName ?? "content";

    // v0.11.4 (issue #76 follow-up) — cold-start gate.
    const gate = await checkColdStartGate(ctx, toolCtx, "compose_page_from_spec");
    if (gate.blocked) return gate.gateResult!;

    // STEP 1 — create the page. Inherits create_page's nextAction
    // recovery (no defaults → list_templates auto-recovery).
    const pageRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.create", {
      slug: input.slug,
      name: input.name,
      title: input.title,
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    if (!pageRes.ok) {
      const next = forwardNextAction(pageRes.error);
      return {
        ok: false,
        content: `compose_page_from_spec: pages.create failed: ${describeError(pageRes.error)}`,
        ...(next ? { nextAction: next } : {}),
      };
    }
    const pageId = (pageRes.value as { pageId: string }).pageId;

    // STEP 2 — verify the target block exists on the page's template.
    // Same shape as add_module_to_page's pre-check.
    const pageDetailRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages.get_with_modules",
      { pageId },
    );
    if (!pageDetailRes.ok) {
      return {
        ok: false,
        content: `compose_page_from_spec: page created (id=${pageId}) but pages.get_with_modules failed for module placement: ${describeError(pageDetailRes.error)}`,
      };
    }
    const page = (pageDetailRes.value as { page: PageWithModules }).page;
    const targetBlock = page.blocks.find((b) => b.blockName === blockName);
    if (!targetBlock) {
      const allowed = page.blocks.map((b) => b.blockName).join(", ");
      return {
        ok: false,
        content: `compose_page_from_spec: page created (id=${pageId}) but block "${blockName}" does not exist on this template — available: ${allowed}. Use edit_template_blocks to add the block, then add_module_to_page individually.`,
      };
    }

    // STEP 3 — create each section module + collect IDs. Per-section
    // failures are reported but the loop continues so partial-success
    // is the worst case (caller can fix gaps individually).
    const createdModuleIds: string[] = [];
    const sectionResults: { idx: number; displayName: string; ok: boolean; reason?: string }[] = [];
    for (let i = 0; i < input.sections.length; i++) {
      const section = input.sections[i];
      if (!section) continue;
      const slug = slugify(section.displayName, i);
      const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
        slug,
        displayName: section.displayName,
        html: section.html,
        css: section.css ?? "",
        js: section.js ?? "",
      });
      if (!created.ok) {
        sectionResults.push({
          idx: i,
          displayName: section.displayName,
          ok: false,
          reason: describeError(created.error),
        });
        continue;
      }
      const moduleId = (created.value as { moduleId: string }).moduleId;
      createdModuleIds.push(moduleId);
      sectionResults.push({ idx: i, displayName: section.displayName, ok: true });
    }

    if (createdModuleIds.length === 0) {
      return {
        ok: false,
        content: `compose_page_from_spec: page created (id=${pageId}) but ALL ${input.sections.length} section modules failed to create. ${sectionResults
          .filter((r) => !r.ok)
          .map((r) => `${r.displayName}: ${r.reason}`)
          .join("; ")}`,
      };
    }

    // STEP 4 — splice the created module IDs onto the target block,
    // preserving any existing modules. (A freshly-created page has an
    // empty content block; if the AI calls this on an existing page
    // with content already there, we append to the end.)
    const existingIds = targetBlock.modules.map((m) => m.moduleId);
    const newBlockIds = [...existingIds, ...createdModuleIds];
    const blocks = page.blocks.map((b) =>
      b.blockName === blockName
        ? { blockName: b.blockName, moduleIds: newBlockIds }
        : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
    );
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId,
      blocks,
    });
    if (!setRes.ok) {
      return {
        ok: false,
        content: `compose_page_from_spec: page created (id=${pageId}), ${createdModuleIds.length}/${input.sections.length} section modules created, but pages.set_modules failed: ${describeError(setRes.error)}. Modules exist but are not attached — re-run with add_module_to_page or call pages.set_modules manually.`,
      };
    }

    // v0.6.1 Layer 3 — SEO autofill inline. The "invisible-by-default"
    // principle: composing a page also fills SEO so the AI never needs
    // a separate set_page_seo round-trip. Honors the SEO fill-once
    // invariant (CLAUDE.md §2) by going through pages_seo.autofill
    // which sets autofilled_at — subsequent content edits won't silently
    // overwrite operator-edited SEO.
    //
    // Skipped when:
    //   - input.seo.skipSeo is true (caller explicitly opts out — e.g.,
    //     stub pages where SEO would be noise),
    //   - autofill rejects with "AlreadyAutofilled" (page existed; we
    //     don't overwrite),
    //   - the derived description would be empty / too short.
    let seoSummary: string | null = null;
    const skipSeo = input.seo?.skipSeo === true;
    if (!skipSeo) {
      const derivedDescription =
        input.seo?.metaDescription ?? deriveSeoDescription(input.title, input.sections);
      if (derivedDescription && derivedDescription.length > 0) {
        const seoArgs: Record<string, unknown> = {
          pageId,
          metaDescription: derivedDescription,
        };
        if (input.seo?.ogImageAssetId) {
          seoArgs.ogImageAssetId = input.seo.ogImageAssetId;
        }
        const seoRes = await execute(
          toolCtx.registry,
          toolCtx.adapter,
          ctx,
          "pages_seo.autofill",
          seoArgs,
        );
        if (seoRes.ok) {
          seoSummary = `SEO autofilled (description: ${derivedDescription.length} chars${input.seo?.metaDescription ? ", caller-supplied" : ", auto-derived"})`;
        } else {
          const errMsg = describeError(seoRes.error);
          // "AlreadyAutofilled" is a no-op informational outcome, not
          // a real failure — page composition succeeded; just note it.
          seoSummary = errMsg.includes("AlreadyAutofilled")
            ? "SEO already autofilled previously — skipped (use optimize_page_seo for explicit re-fill)"
            : `SEO autofill skipped: ${errMsg}`;
        }
      }
    }

    const failed = sectionResults.filter((r) => !r.ok);
    const summary = [
      `compose_page_from_spec: page ${input.slug} (id=${pageId}) created with ${createdModuleIds.length}/${input.sections.length} sections on block "${blockName}".`,
      `module IDs (in order): ${createdModuleIds.join(", ")}`,
      seoSummary,
      failed.length > 0
        ? `FAILED sections: ${failed.map((f) => `[${f.idx}] ${f.displayName} — ${f.reason}`).join("; ")}`
        : null,
    ]
      .filter((s): s is string => s !== null)
      .join("\n");
    return { ok: failed.length === 0, content: summary };
  },
};

/**
 * v0.6.1 — derive a default SEO description from the spec when the
 * caller doesn't supply one. Format: `${title} — ${first 1-2 sections'
 * displayNames}`, capped at SEO_DESCRIPTION_RECOMMENDED_MAX (160) to
 * stay within Google's snippet length without truncation.
 *
 * Returns "" when nothing usable could be derived (e.g., section
 * displayNames are all extremely long); caller then skips the SEO
 * autofill step entirely.
 */
function deriveSeoDescription(title: string, sections: readonly { displayName: string }[]): string {
  const RECOMMENDED_MAX = 160;
  const titlePart = title.trim();
  if (titlePart.length === 0) return "";
  const sectionList = sections
    .slice(0, 2)
    .map((s) => s.displayName.trim())
    .filter((s) => s.length > 0)
    .join(", ");
  const composed = sectionList ? `${titlePart} — ${sectionList}` : titlePart;
  if (composed.length <= RECOMMENDED_MAX) return composed;
  // Composed is too long; fall back to title alone if it fits, else
  // truncate composed at a word boundary near the limit.
  if (titlePart.length <= RECOMMENDED_MAX) return titlePart;
  const truncated = composed.slice(0, RECOMMENDED_MAX);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > RECOMMENDED_MAX - 40 ? truncated.slice(0, lastSpace) : truncated;
}
