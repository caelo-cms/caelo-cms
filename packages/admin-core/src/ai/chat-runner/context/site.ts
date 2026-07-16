// SPDX-License-Identifier: MPL-2.0

/**
 * Site-structure system-prompt context blocks — layouts, site defaults,
 * and site identity (P6.7.6 / P18 / v0.11.4). Extracted verbatim from the
 * pre-split `chat-runner.ts`. Also returns the raw layouts / templates /
 * site-defaults op values the orchestrator feeds to `buildToolDescribeState`.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { DesignManifest, ExecutionContext } from "@caelo-cms/shared";
import { formatDesignSystemBlock } from "@caelo-cms/shared";

import { formatSiteIdentityBlock } from "../../system-prompt.js";

export interface SiteBlocks {
  layoutsBlock: string | undefined;
  siteDefaultsBlock: string | undefined;
  siteIdentityBlock: string | undefined;
  /** issue #165 — `## Design system` from the Design Manifest. */
  designSystemBlock: string | undefined;
  /** Raw op values for buildToolDescribeState (null when the read failed). */
  layoutsValue: unknown;
  templatesValue: unknown;
  siteDefaultsValue: unknown;
}

/**
 * P6.7.6 — layouts (site-wide chrome) + site_defaults so the AI knows which
 * layout/template to use when creating a page and which tool surface
 * (page / template / layout) is appropriate for a given change request.
 * v0.9.0 — uses the branch-aware ctx so the AI sees its own in-flight
 * branched-create layouts + templates.
 */
export async function buildSiteBlocks(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtxWithBranch: ExecutionContext,
): Promise<SiteBlocks> {
  let layoutsBlock: string | undefined;
  let siteDefaultsBlock: string | undefined;
  // v0.11.4 (issue #76 follow-up) — site identity block reads from the
  // same site_defaults row.
  let siteIdentityBlock: string | undefined;
  const layoutsR = await execute(registry, adapter, humanCtxWithBranch, "layouts.list", {
    includeDeleted: false,
  });
  const tplsR = await execute(registry, adapter, humanCtxWithBranch, "templates.list", {
    includeDeleted: false,
  });
  const defaultsR = await execute(registry, adapter, humanCtxWithBranch, "site_defaults.get", {});
  // v0.11.4 (issue #76 follow-up) — always render the ## Site identity
  // block. When defaults are null or both fields are empty, the block
  // carries cold-start instructions telling the AI to capture identity
  // from the first user prompt via `set_site_identity` BEFORE authoring
  // modules. That's the chat-first replacement for the removed
  // /onboarding tour.
  const identityDefaults = defaultsR.ok
    ? (
        defaultsR.value as {
          defaults: {
            siteName: string | null;
            sitePurpose: string | null;
            designBrief: import("@caelo-cms/shared").DesignBrief | null;
          } | null;
        }
      ).defaults
    : null;
  // issue #165 — Design Manifest → `## Design system` block.
  let designSystemBlock: string | undefined;
  const manifestR = await execute(registry, adapter, humanCtxWithBranch, "design_manifest.get", {});
  if (manifestR.ok) {
    const manifest = (manifestR.value as { manifest: DesignManifest | null }).manifest;
    const rendered = formatDesignSystemBlock(manifest);
    if (rendered !== null) designSystemBlock = rendered;
  }

  const identityRender = formatSiteIdentityBlock(identityDefaults);
  if (identityRender) siteIdentityBlock = identityRender;
  if (layoutsR.ok) {
    const layouts = (
      layoutsR.value as {
        layouts: {
          id: string;
          slug: string;
          displayName: string;
          blocks: { name: string; displayName: string }[];
        }[];
      }
    ).layouts;
    if (layouts.length > 0) {
      layoutsBlock = [
        "# Layouts on this site (site-wide chrome)",
        "Layouts wrap every page on every template bound to them. The `content` block always holds the rendered template; other blocks (header, footer, nav) are filled by `add_module` (target='layout').",
        // P18 — include each layout's UUID so the AI can pass `layoutId`
        // to `create_template` / `set_template_layout` without a
        // `layouts.list` round-trip. (`create_template.layoutId` is
        // optional + falls back to site_defaults; this surfaces the
        // non-default options.)
        ...layouts.map(
          (l) =>
            `- ${l.slug} (id=${l.id}) "${l.displayName}" — blocks: ${l.blocks.map((b) => b.name).join(", ")}`,
        ),
        "",
        "One `add_module` tool, routed by `target` — pick by intent:",
        "- one page only        → `add_module` target='page' (targetRef = the page slug or id)",
        "- every page on a template → `add_module` target='template' (targetRef = the template slug or id)",
        "- every page on the site (or a whole layout) → `add_module` target='layout' (targetRef='site-default', blockName='footer')",
        "",
        "Adding a plugin's output (comments, contact form, ratings, newsletter) to a page → `add_plugin_to_page` (per-page placeholder; the static-generator + Web Component handle the rest). Plugins must be installed + active — see `# Plugins` for available slugs.",
        "",
        "`create_layout` is Owner-only (AI calls reject; surface the permission requirement). `set_site_defaults` is AI-callable directly — use it on a fresh install where `# Site defaults` shows '(none configured yet)'.",
      ].join("\n");
    }
  }
  if (defaultsR.ok && tplsR.ok) {
    const defaults = (
      defaultsR.value as {
        defaults: {
          defaultLayoutSlug: string;
          defaultTemplateSlug: string;
        } | null;
      }
    ).defaults;
    const tpls = (tplsR.value as { templates: { id: string; slug: string; layoutId: string }[] })
      .templates;
    const slugByLayoutId = new Map<string, string>();
    if (layoutsR.ok) {
      for (const l of (layoutsR.value as { layouts: { id: string; slug: string }[] }).layouts) {
        slugByLayoutId.set(l.id, l.slug);
      }
    }
    // P18 — include each template's UUID so the AI can pass it as
    // `templateId` to `create_page` / `repoint_page_template` without a
    // separate `templates.list` round-trip. Same for the layout it
    // binds to. (`create_page.templateId` is optional and resolves to
    // site_defaults; this is for the "use a non-default template" path.)
    const templateLines = tpls.map(
      (t) =>
        `- ${t.slug} (id=${t.id}) → ${slugByLayoutId.get(t.layoutId) ?? "(unknown layout)"} (id=${t.layoutId})`,
    );
    siteDefaultsBlock = [
      "# Site defaults (used when caller omits a layout/template)",
      defaults
        ? `- default layout: ${defaults.defaultLayoutSlug}\n- default template: ${defaults.defaultTemplateSlug}`
        : "- (none configured yet — call `set_site_defaults({defaultLayoutSlug, defaultTemplateSlug})` directly to set them, or omit `templateId`/`layoutId` on individual creates to get a structured 'no defaults' error)",
      "",
      "# Templates → layouts",
      ...(templateLines.length > 0 ? templateLines : ["- (no templates yet)"]),
      "",
      // Action sentence anchored to the data above. Reduces AI
      // hedging like "I only have its slug, paste the UUID" — the
      // UUIDs ARE in the lines above; restating the action loop
      // here makes the model use them.
      templateLines.length > 0
        ? `To create a page on a specific template, call create_page with templateId=<UUID from above>. To use the site default, omit templateId entirely. The lines above carry every UUID you need — do NOT ask the operator to paste it.`
        : // v0.5.10 — fresh-install bootstrap path. Pre-v0.5.10 this text
          // primed passive behavior ("ask the operator"). New text names
          // the exact tools and forbids the passive ask explicitly.
          "No templates or layouts exist yet. Bootstrap them yourself: call create_layout to make a layout with three blocks (header, content, footer), then create_template pointing at that layout, then set_site_defaults. Do NOT ask the operator to do this — these tools are available to you. After bootstrap, proceed with the user's original request in the same turn.",
    ].join("\n");
    // Optional debug telemetry. Gated behind CAELO_DEBUG_PROMPT so it
    // costs nothing in production but can be flipped on for one Cloud
    // Run revision to confirm what the AI actually sees.
    if (process.env.CAELO_DEBUG_PROMPT === "1") {
      console.log(
        `[chat-runner] siteDefaultsBlock len=${siteDefaultsBlock.length} preview=${JSON.stringify(siteDefaultsBlock.slice(0, 600))}`,
      );
    }
  } else if (process.env.CAELO_DEBUG_PROMPT === "1") {
    console.log(
      `[chat-runner] siteDefaultsBlock SKIPPED — defaultsR.ok=${defaultsR.ok} tplsR.ok=${tplsR.ok}`,
    );
  }

  return {
    layoutsBlock,
    siteDefaultsBlock,
    siteIdentityBlock,
    designSystemBlock,
    layoutsValue: layoutsR.ok ? layoutsR.value : null,
    templatesValue: tplsR.ok ? tplsR.value : null,
    siteDefaultsValue: defaultsR.ok ? defaultsR.value : null,
  };
}
