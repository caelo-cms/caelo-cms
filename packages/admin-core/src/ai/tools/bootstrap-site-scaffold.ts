// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W4 — composite workflow tool. Bootstraps a fresh install with
 * a sane default layout + template + site_defaults pinning in as few
 * tool calls as the propose/execute boundary allows.
 *
 * The AI repeatedly calls this tool; each invocation makes forward
 * progress on whatever stage is incomplete:
 *
 *   stage 0 (no layout) → propose layouts.create + return "Queued
 *     proposal — click Approve to continue."
 *   stage 1 (layout exists, no template) → templates.create directly
 *     (not gated for AI) + return success.
 *   stage 2 (layout + template exist, no defaults) → site_defaults.set
 *     directly + return success ("bootstrap complete").
 *   stage 3 (all three exist) → return "already bootstrapped" no-op.
 *
 * This shape works under the propose/execute split: layouts.create is
 * Owner-gated, but templates.create and site_defaults.set are
 * direct-callable for AI. So the AI calls this tool, gets the layout
 * proposal queued, the Owner clicks Approve, the AI calls again, and
 * the rest completes. Bootstrap drops from 5+ AI-orchestrated steps
 * to 2 round-trips with one human click between them.
 *
 * Idempotent — calling after stage 3 returns the no-op message;
 * never tramples existing state.
 *
 * v0.12.0 note — the post-bootstrap guidance string still mentions
 * `set_page_module_content`. That tool is now a routing SHIM: it
 * resolves the placement's content_instance_id + sync_mode and
 * forwards to `content_instances.set_values` for unsynced placements
 * (the default after pages.set_modules mints a fresh unsynced
 * content_instance per net-new placement). For synced placements the
 * shim returns a structured error pointing at `fork_placement_content`
 * / `set_content_instance_values`. Fresh installs never see synced
 * placements until the operator explicitly opts in, so the bootstrap
 * recovery path stays simple.
 */

import { execute } from "@caelo-cms/query-api";
import { bootstrapSiteScaffoldToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const DEFAULT_LAYOUT_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>{{title}}</title>
</head>
<body>
<caelo-slot name="header"></caelo-slot>
<caelo-slot name="content"></caelo-slot>
<caelo-slot name="footer"></caelo-slot>
</body>
</html>`;

const DEFAULT_TEMPLATE_HTML = `<caelo-slot name="content"></caelo-slot>`;

const DEFAULT_LAYOUT_BLOCKS = [
  { name: "header", displayName: "Header", position: 0 },
  { name: "content", displayName: "Content", position: 1 },
  { name: "footer", displayName: "Footer", position: 2 },
];

export const bootstrapSiteScaffoldTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BootstrapSiteScaffoldToolInput
> = {
  name: "bootstrap_site_scaffold",
  description:
    "Composite: bootstrap a fresh install (layout + template + site_defaults) in as few steps as the propose/execute gate allows. " +
    "Idempotent — each call makes forward progress on the next missing stage. " +
    "Stage 0 (no layout): queues a layouts.create PROPOSAL; the operator approves it on the proposal card in the chat (queue: /security/layouts/pending). " +
    "Stage 1+2 (layout exists): creates template + pins site_defaults directly (no human click). " +
    "Stage 3 (all three exist): no-op. " +
    "Use on a fresh install when `# Site defaults` says '(none configured yet)'. " +
    "All inputs optional — sensible defaults yield a header/content/footer layout, a single-block `home` template, and pinned defaults. " +
    // 2026-07 — STATIC on purpose (prompt-cache): the stage is auto-
    // detected server-side and the RESULT names the stage that ran plus
    // the next step, so the description doesn't need live state.
    "The stage is detected automatically each call; the tool RESULT tells you which stage ran and what to do next (after a Stage-0 proposal is approved, call this tool AGAIN).",
  schema: bootstrapSiteScaffoldToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      layoutSlug: { type: "string", minLength: 1, maxLength: 120 },
      layoutDisplayName: { type: "string", minLength: 1, maxLength: 256 },
      layoutBlocks: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" },
            displayName: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
      templateSlug: { type: "string", minLength: 1, maxLength: 120 },
      templateDisplayName: { type: "string", minLength: 1, maxLength: 256 },
      setAsDefaults: { type: "boolean" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const layoutSlug = input.layoutSlug ?? "site-default";
    const layoutDisplayName = input.layoutDisplayName ?? "Site default";
    const templateSlug = input.templateSlug ?? "home";
    const templateDisplayName = input.templateDisplayName ?? "Home template";
    const setAsDefaults = input.setAsDefaults ?? true;
    const userBlocks =
      input.layoutBlocks && input.layoutBlocks.length > 0
        ? input.layoutBlocks.map((b, idx) => ({
            name: b.name,
            displayName: b.displayName,
            position: idx,
          }))
        : DEFAULT_LAYOUT_BLOCKS;
    // The `content` block is required (template render target). Insert it
    // at the midpoint if the user-supplied list omitted it.
    const blocks = userBlocks.some((b) => b.name === "content")
      ? userBlocks
      : [
          ...userBlocks.slice(0, Math.floor(userBlocks.length / 2)),
          { name: "content", displayName: "Content", position: 0 },
          ...userBlocks.slice(Math.floor(userBlocks.length / 2)),
        ].map((b, idx) => ({ ...b, position: idx }));

    // Stage detection — check what exists now. Each stage is a single
    // forward-progress action; subsequent stages happen on the next
    // invocation (after the Owner approval for stage 0).
    const layoutsR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {
      includeDeleted: false,
    });
    if (!layoutsR.ok) {
      return { ok: false, content: `layouts.list failed: ${describeError(layoutsR.error)}` };
    }
    const layouts = (layoutsR.value as { layouts: { id: string; slug: string }[] }).layouts;
    if (layouts.length === 0) {
      // STAGE 0 — propose the layout. Owner-gated.
      const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.propose_create", {
        slug: layoutSlug,
        displayName: layoutDisplayName,
        html: DEFAULT_LAYOUT_HTML,
        css: "",
        blocks,
      });
      if (!res.ok) {
        return {
          ok: false,
          content: `bootstrap stage-0 (layouts.propose_create) failed: ${describeError(res.error)}`,
        };
      }
      const v = res.value as { proposalId: string; preview: { blockCount: number } };
      // Canonical "Queued proposal …" prefix so ChatPanel renders the
      // inline ProposeCard with Approve / Reject affordances.
      return {
        ok: true,
        content:
          `Queued proposal ${v.proposalId}: bootstrap stage-0 layout-create slug=${layoutSlug} (${v.preview.blockCount} blocks). ` +
          `Approve it on the proposal card in this chat (queue: /security/layouts/pending). After approval, call bootstrap_site_scaffold again to continue with the template + site_defaults.`,
      };
    }

    const templatesR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", {
      includeDeleted: false,
    });
    if (!templatesR.ok) {
      return { ok: false, content: `templates.list failed: ${describeError(templatesR.error)}` };
    }
    const templates = (templatesR.value as { templates: { id: string; slug: string }[] }).templates;
    // layouts.length > 0 was checked above (STAGE 0 returned early when
    // empty); first-element access here is safe.
    const targetLayout = layouts.find((l) => l.slug === layoutSlug) ?? layouts[0];
    if (!targetLayout) {
      return { ok: false, content: "bootstrap_site_scaffold: no layout available (unexpected)" };
    }

    let createdTemplateId: string | null = null;
    if (templates.length === 0) {
      // STAGE 1 — create the template directly (templates.create is
      // AI-callable; pass layoutId explicitly so the op doesn't hit
      // the site_defaults nextAction recovery path).
      const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.create", {
        slug: templateSlug,
        displayName: templateDisplayName,
        html: DEFAULT_TEMPLATE_HTML,
        css: "",
        layoutId: targetLayout.id,
      });
      if (!res.ok) {
        return {
          ok: false,
          content: `bootstrap stage-1 (templates.create) failed: ${describeError(res.error)}`,
        };
      }
      createdTemplateId = (res.value as { templateId: string }).templateId;
    }

    if (!setAsDefaults) {
      return {
        ok: true,
        content: createdTemplateId
          ? `bootstrap stage-1: template ${templateSlug} (id=${createdTemplateId}) created bound to layout ${targetLayout.slug}; setAsDefaults=false so site_defaults left unchanged.`
          : `bootstrap: layout ${targetLayout.slug} + template(s) ${templates.map((t) => t.slug).join(", ")} exist; setAsDefaults=false so no further action.`,
      };
    }

    // STAGE 2 — pin site_defaults. site_defaults.get tells us whether
    // we still have work to do.
    const defaultsR = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "site_defaults.get",
      {},
    );
    if (!defaultsR.ok) {
      return {
        ok: false,
        content: `bootstrap stage-2 (site_defaults.get) failed: ${describeError(defaultsR.error)}`,
      };
    }
    const existingDefaults = (
      defaultsR.value as {
        defaults: { defaultLayoutId: string; defaultTemplateId: string } | null;
      }
    ).defaults;

    // Refresh templates list (we may have just created one).
    const finalTemplates: { id: string; slug: string }[] = createdTemplateId
      ? [...templates, { id: createdTemplateId, slug: templateSlug }]
      : templates;
    const targetTemplate = finalTemplates.find((t) => t.slug === templateSlug) ?? finalTemplates[0];
    if (!targetTemplate) {
      return { ok: false, content: "bootstrap_site_scaffold: no template available (unexpected)" };
    }

    if (existingDefaults) {
      return {
        ok: true,
        content: `Bootstrap already complete — site_defaults points at layout=${targetLayout.slug}, template=${targetTemplate.slug}. No action taken.`,
      };
    }

    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "site_defaults.set", {
      defaultLayoutId: targetLayout.id,
      defaultTemplateId: targetTemplate.id,
    });
    if (!setRes.ok) {
      return {
        ok: false,
        content: `bootstrap stage-2 (site_defaults.set) failed: ${describeError(setRes.error)}`,
      };
    }
    // v0.7.4 — stronger continuation directive. Pre-v0.7.4 the message
    // was "Bootstrap complete + you can omit templateId now", which the
    // AI consistently read as "task done" and stopped, even when the
    // user's original request was a multi-step "build me a site" ask.
    // The new wording makes it explicit that bootstrap is the SETUP,
    // not the goal — continue with create_page for whatever the user
    // described.
    return {
      ok: true,
      content:
        `Site scaffold ready — layout ${targetLayout.slug} (id=${targetLayout.id}), template ${targetTemplate.slug} (id=${targetTemplate.id}), site_defaults pinned. ` +
        `This was the SETUP step, not the deliverable. Continue with the user's original ask now: call create_page for each page they described (omit templateId — it's pinned), then add_module / set_page_module_content to fill them in. ` +
        `Do not stop here unless the user only asked for the scaffold.`,
      nextAction: {
        tool: "create_page",
        reason:
          "bootstrap finished the SETUP; the user's deliverable usually starts with creating at least one page. Use the slug/locale/title they described in the original message. Skip ONLY if the user explicitly asked for the scaffold alone.",
      },
    };
  },
};
