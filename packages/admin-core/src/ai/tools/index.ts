// SPDX-License-Identifier: MPL-2.0

import { addModuleToLayoutTool } from "./add-module-to-layout.js";
import { addModuleToPageTool } from "./add-module-to-page.js";
import { addModuleToTemplateTool } from "./add-module-to-template.js";
import { addPluginToPageTool } from "./add-plugin-to-page.js";
import { autofillPageSeoTool } from "./autofill-page-seo.js";
import { bootstrapSiteScaffoldTool } from "./bootstrap-site-scaffold.js";
import { bulkCreateRedirectsTool } from "./bulk-create-redirects.js";
import { bulkDeleteRedirectsTool } from "./bulk-delete-redirects.js";
import { bulkOptimizeSeoTool } from "./bulk-optimize-seo.js";
import {
  deletePagesManyTool,
  updateModulesManyTool,
  updatePagesManyTool,
} from "./bulk-pages-modules.js";
import { cancelProposalTool } from "./cancel-proposal.js";
import { changePageSlugTool } from "./change-page-slug.js";
import { changeTemplateTool } from "./change-template.js";
import { composeFromImportTool } from "./compose-from-import.js";
import { composePageFromSpecTool } from "./compose-page-from-spec.js";
import { createContentInstanceTool } from "./create-content-instance.js";
import { createLayoutTool } from "./create-layout.js";
import { createPageTool } from "./create-page.js";
import { createTemplateTool } from "./create-template.js";
import { deleteContentInstanceTool } from "./delete-content-instance.js";
import { deletePageTool } from "./delete-page.js";
import { deleteStructuredSetTool } from "./delete-structured-set.js";
import { ToolRegistry } from "./dispatch.js";
import { duplicatePageTool } from "./duplicate-page.js";
import { duplicateThemeTool } from "./duplicate-theme.js";
import { editModuleTool } from "./edit-module.js";
import { exportThemeTool } from "./export-theme.js";
import { findMediaTool } from "./find-media.js";
import { findRedirectsTool } from "./find-redirects.js";
import { forkPlacementContentTool } from "./fork-placement-content.js";
import { generateImageTool } from "./generate-image.js";
import {
  listGenesisDraftsTool,
  saveGenesisDraftTool,
  selectGenesisDraftTool,
} from "./genesis-tools.js";
import { getContentInstanceTool } from "./get-content-instance.js";
import { getStructuredSetTool } from "./get-structured-set.js";
import { getThemeTool } from "./get-theme.js";
import { importThemeTool } from "./import-theme.js";
import { inspectBuiltPageTool } from "./inspect-built-page.js";
import { inspectGenesisDraftTool } from "./inspect-genesis-draft.js";
import { inspectPageRenderTool } from "./inspect-page-render.js";
import { listContentInstancesTool } from "./list-content-instances.js";
import { listLayoutsTool } from "./list-layouts.js";
import { listModulesTool } from "./list-modules.js";
import { listPagesTool } from "./list-pages.js";
import { listStructuredSetsTool } from "./list-structured-sets.js";
import { listTemplatesTool } from "./list-templates.js";
import { listThemeHistoryTool } from "./list-theme-history.js";
import { listThemesTool } from "./list-themes.js";
import { moveModuleTool } from "./move-module.js";
import { optimizePageSeoTool } from "./optimize-page-seo.js";
import { proposeAddLocaleTool } from "./propose-add-locale.js";
import { proposeDeployPromoteTool, proposeDeployRollbackTool } from "./propose-deploy-promote.js";
import { proposeRemoveLocaleTool } from "./propose-remove-locale.js";
import { proposeSetDefaultLocaleTool } from "./propose-set-default-locale.js";
import { proposeSiteImportTool } from "./propose-site-import.js";
import { proposeSkillTool } from "./propose-skill.js";
import {
  proposeActivateThemeTool,
  proposeAiProvidersClearKeyTool,
  proposeAiProvidersSetTool,
  proposeCreateThemeTool,
  proposeDeleteThemeTool,
  proposeDomainAddTool,
  proposeDomainRemoveTool,
  proposeEmailConfigSetTool,
  proposeExperimentActivateTool,
  proposeExperimentCompleteTool,
  proposeLayoutCreateTool,
  proposeLayoutDeleteTool,
  proposeLayoutSetBlocksTool,
  proposeLayoutUpdateTool,
  proposeMcpTokenCreateTool,
  proposeMcpTokenRevokeTool,
  proposeRevertModuleTool,
  proposeRevertPageTool,
  proposeRevertSiteTool,
  proposeRevertTemplateTool,
  proposeRoleCreateTool,
  proposeRoleDeleteTool,
  proposeRoleUpdatePermissionsTool,
  proposeTemplateDeleteTool,
  proposeTemplateUpdateTool,
  proposeUserCreateTool,
  proposeUserDeleteTool,
  proposeUserSetRolesTool,
} from "./propose-tools-batch.js";
import { proposeUpdateLocaleStrategyTool } from "./propose-update-locale-strategy.js";
import { removeModuleFromLayoutTool } from "./remove-module-from-layout.js";
import { removeModuleFromPageTool } from "./remove-module-from-page.js";
import { renamePageTool } from "./rename-page.js";
import { reorderModuleTool } from "./reorder-module.js";
import { revertChatChangesTool } from "./revert-chat-changes.js";
import { screenshotPageTool } from "./screenshot-page.js";
import { setContentInstanceValuesTool } from "./set-content-instance-values.js";
import { setMediaAltTool } from "./set-media-alt.js";
import { setPageModuleContentTool } from "./set-page-module-content.js";
import { setPageSeoTool } from "./set-page-seo.js";
import { setPageStatusTool } from "./set-page-status.js";
import { setPageTitleTool } from "./set-page-title.js";
import { setPagesStatusManyTool } from "./set-pages-status-many.js";
import { setPlacementContentTool } from "./set-placement-content.js";
import { setSiteDefaultsTool } from "./set-site-defaults.js";
import { setSiteIdentityTool } from "./set-site-identity.js";
import { setStructuredSetTool } from "./set-structured-set.js";
import { setTemplateLayoutTool } from "./set-template-layout.js";
import { setThemeAssetTool } from "./set-theme-asset.js";
import { setThemeMetaTool } from "./set-theme-meta.js";
import { siteMemoryProposeTool } from "./site-memory-propose.js";
import { spawnSubagentsTool, spawnSubagentTool } from "./spawn-subagent.js";
import { submitPluginTool } from "./submit-plugin.js";
// P11.5 — translate_page + start_translation_job moved to the translation
// Tier-1 plugin (`packages/plugins/translation/`). The chat-runner discovers
// them via @caelo-cms/plugin-host's pluginToolsRegistry on each turn.
import { tuneRateLimitTool } from "./tune-rate-limit.js";
import { updateThemeTokensTool } from "./update-theme-tokens.js";

/**
 * Registers every shipped tool against a fresh ToolRegistry. Tests can
 * spin up their own registry with a subset; production uses this one.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(editModuleTool);
  registry.register(setPageModuleContentTool);
  // v0.12.0 — content_instances + placement binding tools.
  registry.register(listContentInstancesTool);
  registry.register(getContentInstanceTool);
  registry.register(createContentInstanceTool);
  registry.register(setContentInstanceValuesTool);
  registry.register(deleteContentInstanceTool);
  registry.register(setPlacementContentTool);
  registry.register(forkPlacementContentTool);
  // v0.5.12 — explicit read fallbacks for layouts / templates / pages.
  // Mirror the system-prompt `# Layouts on this site` / `# Templates →
  // layouts` / `# All pages` context blocks. Existed only as system-prompt
  // text before; the AI had no fetch path when it claimed to lack a UUID.
  registry.register(listLayoutsTool);
  registry.register(listTemplatesTool);
  registry.register(listPagesTool);
  // issue #159 — the `## Modules` block's full-catalog escape hatch.
  registry.register(listModulesTool);
  // issue #163 — Site Genesis draft storage (workflow lives in the site-genesis skill).
  registry.register(saveGenesisDraftTool);
  registry.register(listGenesisDraftsTool);
  registry.register(selectGenesisDraftTool);
  // issue #164 — compiler stage 1: draft fact base for materialisation.
  registry.register(inspectGenesisDraftTool);
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
  // v0.10.22 — unified structured-sets CRUD surface. Replaces the
  // kind-specific wrappers `set_nav_menu` and `update_theme`. The AI
  // discriminates by `kind` argument; the per-kind JSON Schema on
  // `set_structured_set` enforces the right item shape at the
  // tool-call boundary.
  registry.register(setStructuredSetTool);
  registry.register(listStructuredSetsTool);
  registry.register(getStructuredSetTool);
  registry.register(deleteStructuredSetTool);
  // P6.7.6 — layout layer.
  registry.register(addModuleToLayoutTool);
  registry.register(removeModuleFromLayoutTool);
  registry.register(setTemplateLayoutTool);
  registry.register(createLayoutTool);
  registry.register(setSiteDefaultsTool);
  // v0.11.4 (issue #76 follow-up) — AI-driven site identity capture
  // (Caelo is chat-first per §1A; no forms-based onboarding).
  registry.register(setSiteIdentityTool);
  // v0.6.0 W4 — composite bootstrap. Wraps the layouts / templates /
  // site_defaults chain. Idempotent — successive calls drive the
  // bootstrap forward across the propose/execute Owner-approval gap.
  registry.register(bootstrapSiteScaffoldTool);
  registry.register(composePageFromSpecTool);
  registry.register(revertChatChangesTool);
  // P6.7.7 — content-ops follow-ups.
  registry.register(duplicatePageTool);
  registry.register(changeTemplateTool);
  registry.register(moveModuleTool);
  registry.register(reorderModuleTool);
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
  // v0.2.69 — render inspection. AI uses this BEFORE proposing CSS
  // / layout fixes so it sees the actual cascade instead of guessing.
  registry.register(inspectPageRenderTool);
  registry.register(inspectBuiltPageTool);
  // v0.3.1 — browser-mediated screenshot. For visual feedback only;
  // CSS pathology should use inspect_page_render instead.
  registry.register(screenshotPageTool);
  registry.register(bulkCreateRedirectsTool);
  registry.register(bulkDeleteRedirectsTool);
  registry.register(bulkOptimizeSeoTool);
  // v0.2.33 — bulk variants for pages + modules (CLAUDE.md §11
  // "every routine domain ships a bulk variant"). delete_many for the
  // operator's "drop these N stale posts" case; update_many for
  // metadata edits across many pages/modules in one tool call.
  registry.register(deletePagesManyTool);
  registry.register(updatePagesManyTool);
  registry.register(updateModulesManyTool);
  // v0.9.13 — singular + bulk status flip. Drafts are LIVE-EDIT ONLY;
  // only `published` pages ship to Stage / Production. Bulk variant
  // saves N round-trips when the user asks to flip a batch.
  registry.register(setPageStatusTool);
  registry.register(setPagesStatusManyTool);
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
  // v0.2.19 — first deploy gate via §11.A. AI proposes a promote /
  // rollback; Owner clicks Approve at /security/deployments/pending.
  // The execute side stays human-only.
  registry.register(proposeDeployPromoteTool);
  registry.register(proposeDeployRollbackTool);
  // v0.2.31 — propose tools for every gated domain shipped in
  // v0.2.20 → v0.2.30. The underlying *.propose_* ops were already
  // registered in the operation registry; this surfaces them as
  // chat-runner-callable tools so the AI can actually queue
  // proposals through the standard tool-call loop.
  registry.register(proposeLayoutCreateTool);
  registry.register(proposeLayoutUpdateTool);
  registry.register(proposeLayoutDeleteTool);
  registry.register(proposeLayoutSetBlocksTool);
  registry.register(proposeUserCreateTool);
  registry.register(proposeUserSetRolesTool);
  registry.register(proposeUserDeleteTool);
  registry.register(proposeRoleCreateTool);
  registry.register(proposeRoleUpdatePermissionsTool);
  registry.register(proposeRoleDeleteTool);
  registry.register(proposeRevertSiteTool);
  registry.register(proposeRevertPageTool);
  registry.register(proposeRevertTemplateTool);
  registry.register(proposeRevertModuleTool);
  registry.register(proposeExperimentActivateTool);
  registry.register(proposeExperimentCompleteTool);
  registry.register(proposeEmailConfigSetTool);
  registry.register(proposeAiProvidersSetTool);
  registry.register(proposeAiProvidersClearKeyTool);
  registry.register(proposeMcpTokenCreateTool);
  registry.register(proposeMcpTokenRevokeTool);
  registry.register(proposeTemplateUpdateTool);
  registry.register(proposeTemplateDeleteTool);
  registry.register(proposeDomainAddTool);
  registry.register(proposeDomainRemoveTool);
  // v0.2.37 — AI can withdraw its own pending proposals.
  registry.register(cancelProposalTool);
  // v0.11.0 — themes primitive (#45). Routine + the §11.A propose
  // wrappers for create / activate / delete.
  registry.register(listThemesTool);
  registry.register(getThemeTool);
  registry.register(updateThemeTokensTool);
  // v0.11.4 (issue #76 follow-up) — record design intent + read history.
  registry.register(setThemeMetaTool);
  registry.register(listThemeHistoryTool);
  registry.register(setThemeAssetTool);
  registry.register(duplicateThemeTool);
  registry.register(importThemeTool);
  registry.register(exportThemeTool);
  registry.register(proposeCreateThemeTool);
  registry.register(proposeActivateThemeTool);
  registry.register(proposeDeleteThemeTool);
  return registry;
}

export { type ToolContext, ToolRegistry, type ToolResult } from "./dispatch.js";
