// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.16 — `add_plugin_to_page`. Lets the AI place a plugin's
 * `<div data-caelo-plugin>` placeholder on a specific page in one
 * tool call, instead of asking the operator to hand-edit template
 * HTML. The placeholder is the contract the static-generator's
 * plugin-pass + the plugin's Web Component both consume.
 *
 * Implementation: the placeholder lives inside a synthetic module
 * (one per page x plugin instance), which slots into the page's
 * existing module list at the requested block + position. This way
 * the existing `pages.set_modules` validator runs unchanged — pages
 * still reference modules only — and the per-page module carries
 * the right `data-page-id` + `data-locale` for the static-generator
 * regex to match.
 *
 * Pre-flight checks:
 *   1. plugin loaded + active (resolves via plugin-host's in-memory
 *      registry — covers Tier-1 directly + Tier-2 stubs from v0.2.16's
 *      DB load, with an explicit error for Tier-2 since execution
 *      isn't wired yet).
 *   2. block exists on the page.
 *   3. page row's locale is readable so the placeholder embeds the
 *      right value.
 */

import { loadedPlugins } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { addPluginToPageToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

interface PageRow {
  id: string;
  locale: string;
}

function uniqueSlug(pluginSlug: string): string {
  return `plugin-${pluginSlug}-${Date.now().toString(36)}`;
}

export const addPluginToPageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").AddPluginToPageToolInput
> = {
  name: "add_plugin_to_page",
  description:
    "Place a plugin's output (comments thread, contact form, ratings widget, newsletter signup, etc.) on ONE page at a chosen block + position. " +
    "Use this for 'add comments to /about' or 'put a ratings widget at the bottom of /blog/spring-launch'. " +
    "The plugin must already be installed + active — check `# Plugins` in the system prompt for available slugs. " +
    "For site-wide placement (every blog post, every page on a template) call this tool once per page; a fan-out variant is a follow-up.",
  schema: addPluginToPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "pluginSlug", "blockName", "position"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      pluginSlug: { type: "string", minLength: 1, maxLength: 80 },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: {
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // 1. Confirm the plugin is loaded.
    const loaded = loadedPlugins.bySlug(input.pluginSlug);
    if (!loaded) {
      return {
        ok: false,
        content: `plugin "${input.pluginSlug}" is not loaded. Check /security/plugins for installed plugins; the slug must match exactly.`,
      };
    }
    if (loaded.executionStub) {
      return {
        ok: false,
        content: `plugin "${input.pluginSlug}" is registered but its Tier-2 execution runtime is not yet wired — placement would result in an empty placeholder. Use a Tier-1 (PR-shipped) plugin instead, or wait for the runtime ship.`,
      };
    }

    // 2. Read the page's locale so the placeholder embeds the right value.
    const pageR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get", {
      pageId: input.pageId,
    });
    if (!pageR.ok) {
      return {
        ok: false,
        content: `pages.get failed: ${describeError(pageR.error)}`,
      };
    }
    const page = (pageR.value as { page: PageRow | null }).page;
    if (!page) {
      return { ok: false, content: `page ${input.pageId} not found or deleted` };
    }
    const locale = page.locale;

    // 3. Read the page's existing block layout to validate the target
    //    block + compute the splice index.
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok) {
      return {
        ok: false,
        content: `pages.get_with_modules failed: ${describeError(got.error)}`,
      };
    }
    const pageBlocks = (got.value as { page: PageWithModules }).page;
    const targetBlock = pageBlocks.blocks.find((b) => b.blockName === input.blockName);
    if (!targetBlock) {
      const allowed = pageBlocks.blocks.map((b) => b.blockName).join(", ");
      return {
        ok: false,
        content: `block "${input.blockName}" does not exist on this page's template. Available blocks: ${allowed}`,
      };
    }

    // 4. Create the synthetic module that wraps the placeholder div.
    //    Static-generator's plugin-pass regex is loose around the
    //    placeholder (any inner text becomes the bake target), so the
    //    initial inner copy is just a polite "loading" sentence that
    //    gets replaced at deploy.
    const moduleSlug = uniqueSlug(input.pluginSlug);
    const placeholderHtml =
      `<div data-caelo-plugin="${escapeAttr(input.pluginSlug)}" ` +
      `data-page-id="${escapeAttr(input.pageId)}" ` +
      `data-locale="${escapeAttr(locale)}">` +
      `<!-- ${escapeAttr(input.pluginSlug)} loads here -->` +
      `</div>`;
    const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
      slug: moduleSlug,
      displayName: `${input.pluginSlug} (placeholder)`,
      html: placeholderHtml,
      css: "",
      js: "",
    });
    if (!created.ok) {
      return {
        ok: false,
        content: `modules.create failed: ${describeError(created.error)}`,
      };
    }
    const newModuleId = (created.value as { moduleId: string }).moduleId;

    // 5. Splice into the target block at the requested position.
    const existingIds = targetBlock.modules.map((m) => m.moduleId);
    const insertIdx =
      input.position === "top"
        ? 0
        : input.position === "bottom"
          ? existingIds.length
          : Math.min(input.position, existingIds.length);
    const newBlockIds = [
      ...existingIds.slice(0, insertIdx),
      newModuleId,
      ...existingIds.slice(insertIdx),
    ];
    const blocks = pageBlocks.blocks.map((b) =>
      b.blockName === input.blockName
        ? { blockName: b.blockName, moduleIds: newBlockIds }
        : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
    );
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return {
        ok: false,
        content: `pages.set_modules failed: ${describeError(setRes.error)}`,
      };
    }
    return {
      ok: true,
      content:
        `placed plugin "${input.pluginSlug}" on page ${input.pageId} ` +
        `(block="${input.blockName}", position=${insertIdx}, moduleId=${newModuleId}). ` +
        `Plugin will render at the next deploy.`,
    };
  },
};

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
