// SPDX-License-Identifier: MPL-2.0

import { addModuleToLayoutTool } from "./add-module-to-layout.js";
import { addModuleToPageTool } from "./add-module-to-page.js";
import { addModuleToTemplateTool } from "./add-module-to-template.js";
import { addPluginToPageTool } from "./add-plugin-to-page.js";
import { autofillPageSeoTool } from "./autofill-page-seo.js";
import { bulkCreateRedirectsTool } from "./bulk-create-redirects.js";
import { bulkDeleteRedirectsTool } from "./bulk-delete-redirects.js";
import { bulkOptimizeSeoTool } from "./bulk-optimize-seo.js";
import { changePageSlugTool } from "./change-page-slug.js";
import { changeTemplateTool } from "./change-template.js";
import { composeFromImportTool } from "./compose-from-import.js";
import { createLayoutTool } from "./create-layout.js";
import { createPageTool } from "./create-page.js";
import { createTemplateTool } from "./create-template.js";
import { deletePageTool } from "./delete-page.js";
import { ToolRegistry } from "./dispatch.js";
import { duplicatePageTool } from "./duplicate-page.js";
import { editModuleTool } from "./edit-module.js";
import { findMediaTool } from "./find-media.js";
import { findRedirectsTool } from "./find-redirects.js";
import { generateImageTool } from "./generate-image.js";
import { moveModuleTool } from "./move-module.js";
import { optimizePageSeoTool } from "./optimize-page-seo.js";
import { proposeAddLocaleTool } from "./propose-add-locale.js";
import { proposeRemoveLocaleTool } from "./propose-remove-locale.js";
import { proposeSetDefaultLocaleTool } from "./propose-set-default-locale.js";
import { proposeSiteImportTool } from "./propose-site-import.js";
import { proposeSkillTool } from "./propose-skill.js";
import { proposeUpdateLocaleStrategyTool } from "./propose-update-locale-strategy.js";
import { removeModuleFromLayoutTool } from "./remove-module-from-layout.js";
import { removeModuleFromPageTool } from "./remove-module-from-page.js";
import { renamePageTool } from "./rename-page.js";
import { reorderModuleTool } from "./reorder-module.js";
import { setMediaAltTool } from "./set-media-alt.js";
import { setNavMenuTool } from "./set-nav-menu.js";
import { setPageSeoTool } from "./set-page-seo.js";
import { setPageTitleTool } from "./set-page-title.js";
import { setSiteDefaultsTool } from "./set-site-defaults.js";
import { setStructuredSetTool } from "./set-structured-set.js";
import { setTemplateLayoutTool } from "./set-template-layout.js";
import { siteMemoryProposeTool } from "./site-memory-propose.js";
import { spawnSubagentsTool, spawnSubagentTool } from "./spawn-subagent.js";
import { submitPluginTool } from "./submit-plugin.js";
// P11.5 — translate_page + start_translation_job moved to the translation
// Tier-1 plugin (`packages/plugins/translation/`). The chat-runner discovers
// them via @caelo-cms/plugin-host's pluginToolsRegistry on each turn.
import { tuneRateLimitTool } from "./tune-rate-limit.js";
import { updateThemeTool } from "./update-theme.js";

/**
 * Registers every shipped tool against a fresh ToolRegistry. Tests can
 * spin up their own registry with a subset; production uses this one.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(editModuleTool);
  registry.register(siteMemoryProposeTool);
  registry.register(addModuleToPageTool);
  registry.register(addModuleToTemplateTool);
  // v0.2.16 — place a plugin's output on a page (synthetic placeholder
  // module). Tier-1 plugins go live at next deploy; Tier-2 stubs reject
  // with a clear "execution runtime pending" message.
  registry.register(addPluginToPageTool);
  registry.register(createPageTool);
  registry.register(createTemplateTool);
  registry.register(composeFromImportTool);
  registry.register(renamePageTool);
  registry.register(setPageTitleTool);
  registry.register(changePageSlugTool);
  registry.register(deletePageTool);
  registry.register(removeModuleFromPageTool);
  registry.register(setStructuredSetTool);
  registry.register(updateThemeTool);
  // P6.7.6 — layout layer.
  registry.register(addModuleToLayoutTool);
  registry.register(removeModuleFromLayoutTool);
  registry.register(setTemplateLayoutTool);
  registry.register(createLayoutTool);
  registry.register(setSiteDefaultsTool);
  // P6.7.7 — content-ops follow-ups.
  registry.register(duplicatePageTool);
  registry.register(changeTemplateTool);
  registry.register(moveModuleTool);
  registry.register(reorderModuleTool);
  registry.register(setNavMenuTool);
  // P7 — media library.
  registry.register(findMediaTool);
  registry.register(setMediaAltTool);
  // P16 — AI image generation via the active provider's image endpoint.
  registry.register(generateImageTool);
  // P8 — SEO sidecar tools.
  registry.register(setPageSeoTool);
  registry.register(autofillPageSeoTool);
  registry.register(optimizePageSeoTool);
  // P8 AI-first review pass — bulk variants + redirect surface.
  registry.register(findRedirectsTool);
  registry.register(bulkCreateRedirectsTool);
  registry.register(bulkDeleteRedirectsTool);
  registry.register(bulkOptimizeSeoTool);
  // P9 — locale propose tools (CLAUDE.md §11.A two-step gate).
  registry.register(proposeAddLocaleTool);
  registry.register(proposeRemoveLocaleTool);
  registry.register(proposeSetDefaultLocaleTool);
  registry.register(proposeUpdateLocaleStrategyTool);
  // P10 — AI translation surface MOVED to the translation Tier-1 plugin
  // (P11.5 commit 2). The plugin's `tools[]` declaration registers
  // `translate_page` + `start_translation_job` into pluginToolsRegistry at
  // bootstrap; chat-runner folds them into its catalogue per turn.
  // P10A — AI proposes a new skill body for Owner review.
  registry.register(proposeSkillTool);
  // P10.5 — AI spawns subagents (single + plural) for parallel
  // reasoning. Same chat-runner code path; child runs with
  // excludedToolNames stripping these two so depth is capped at 1.
  registry.register(spawnSubagentTool);
  registry.register(spawnSubagentsTool);
  // P11 — AI submits a Tier 2 plugin for Owner approval. Activation
  // is human-only (CLAUDE.md §2). Tier 1 plugins ship via human PR.
  registry.register(submitPluginTool);
  // P13 — AI proposes a per-(plugin, op) rate-limit override (§11.A).
  registry.register(tuneRateLimitTool);
  // P14 — AI proposes a Site Import crawl (§11.A).
  registry.register(proposeSiteImportTool);
  return registry;
}

export { type ToolContext, ToolRegistry, type ToolResult } from "./dispatch.js";
