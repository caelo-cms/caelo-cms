// SPDX-License-Identifier: MPL-2.0

import type { OperationRegistry } from "@caelo-cms/query-api";
import { loginOp, logoutOp, resolveSessionOp } from "./ops/auth.js";
import {
  appendChatMessageOp,
  cacheToolResultOp,
  lookupToolResultOp,
  markChatMessageInterruptedOp,
  recordAiCallOp,
} from "./ops/chat/messages.js";
import { publishChatSessionOp } from "./ops/chat/publish.js";
import {
  archiveChatSessionOp,
  createChatSessionOp,
  getChatSessionOp,
  listBranchEditedModulesOp,
  listChatSessionsOp,
  renameChatSessionOp,
  setPinnedElementsOp,
} from "./ops/chat/sessions.js";
import {
  createLayoutOp,
  deleteLayoutOp,
  getLayoutBlockModulesOp,
  getLayoutOp,
  listLayoutsOp,
  setLayoutBlocksOp,
  setLayoutModulesOp,
  updateLayoutOp,
} from "./ops/content/layouts.js";
import {
  createModuleOp,
  deleteModuleOp,
  deleteModulesManyOp,
  getModuleOp,
  listModulesOp,
  updateModuleOp,
} from "./ops/content/modules.js";
import {
  changeTemplateOp,
  createPageOp,
  deletePageOp,
  duplicatePageOp,
  getPageOp,
  getPageWithModulesOp,
  listPagesOp,
  setPageModulesOp,
  updatePageOp,
} from "./ops/content/pages.js";
import { renderPagePreviewOp } from "./ops/content/preview.js";
import { setTemplateBlocksOp } from "./ops/content/template_blocks.js";
import {
  createTemplateOp,
  deleteTemplateOp,
  getTemplateOp,
  listTemplatesOp,
  setTemplateLayoutOp,
  updateTemplateOp,
} from "./ops/content/templates.js";
import { translationStatusMatrixOp } from "./ops/content/translation_status.js";
import {
  listDeployRunsOp,
  listDeployTargetsOp,
  promoteDeployOp,
  rollbackDeployOp,
  triggerDeployOp,
  updateDeployProgressOp,
} from "./ops/deploy.js";
import {
  addDomainOp,
  listDomainsOp,
  removeDomainOp,
  setDomainTlsStatusOp,
  verifyDomainOp,
} from "./ops/domains.js";
import { getEmailConfigOp, setEmailConfigOp } from "./ops/email_config.js";
import {
  activateExperimentOp,
  completeExperimentOp,
  createExperimentOp,
  getExperimentResultsOp,
  listExperimentsOp,
  recordAssignmentOp,
} from "./ops/experiments.js";
import {
  executeRateLimitProposalOp,
  getGatewaySettingsOp,
  listGatewayAnalyticsOp,
  listGatewayRequestsOp,
  listPendingRateLimitProposalsOp,
  listRateLimitProfilesOp,
  proposeRateLimitOp,
  rejectRateLimitProposalOp,
  rotateCookieSecretOp,
  setGatewaySettingsOp,
  setRateLimitOverrideOp,
  setRateLimitProfileOp,
} from "./ops/gateway.js";
import {
  acceptImportedPageOp,
  acknowledgeImportPageDiffOp,
  cleanupImportRunOp,
  composeFromImportRunOp,
  createImportRunOp,
  executeImportProposalOp,
  getImportRunOp,
  listImportRunsOp,
  listPendingImportProposalsOp,
  proposeImportRunOp,
  rejectImportProposalOp,
  updateImportRunStatusOp,
  updatePageDiffOp,
  writeExtractedPagesOp,
} from "./ops/imports.js";
import {
  executeLocaleProposalOp,
  getLocaleOp,
  listLocalesOp,
  listPendingLocaleProposalsOp,
  proposeCreateLocaleOp,
  proposeDeleteLocaleOp,
  proposeSetDefaultLocaleOp,
  proposeUpdateStrategyOp,
  rejectLocaleProposalOp,
} from "./ops/locales.js";
import {
  addCropOp,
  deleteCropOp,
  getProcessingStatusOp,
  listAltProposalsOp,
  listCropsOp,
  mediaDeleteManyOp,
  mediaDeleteOp,
  mediaGetOp,
  mediaGetSettingsOp,
  mediaListOp,
  mediaListUsagesOp,
  mediaRecentForAiOp,
  mediaRecordUsageOp,
  mediaUpdateAltOp,
  mediaUploadOp,
  proposeAltOp,
  reviewAltProposalOp,
  setFocalPointOp,
  setMediaCdnOp,
} from "./ops/media.js";
import { aggregateNotificationsOp } from "./ops/notifications.js";
import {
  anyBootstrapTokenIssuedOp,
  consumeBootstrapTokenOp,
  insertBootstrapTokenOp,
} from "./ops/owner-bootstrap-tokens.js";
import {
  commentArchiveInsertOp,
  commentArchiveListForPageOp,
} from "./ops/plugins/comment_archive.js";
import {
  activatePluginOp,
  disablePluginOp,
  getPluginOp,
  listPendingPluginsOp,
  listPluginsOp,
  preparePluginActivationOp,
  rejectPluginOp,
  revalidatePluginOp,
  submitPluginOp,
} from "./ops/plugins/registry.js";
import {
  getProvisioningOutputsOp,
  setProvisioningOutputsOp,
  verifyDnsRecordOp,
} from "./ops/provisioning_outputs.js";
import {
  createRedirectOp,
  createRedirectsManyOp,
  deleteRedirectOp,
  deleteRedirectsManyOp,
  listRedirectsOp,
  lookupRedirectOp,
} from "./ops/redirects.js";
import { createRoleOp, deleteRoleOp, listRolesOp, updateRolePermissionsOp } from "./ops/roles.js";
import { aiBudgetsStatusOp, listAiBudgetsOp, setAiBudgetOp } from "./ops/security/ai_budgets.js";
import {
  aggregateAiCallsOp,
  aggregatePluginAiSpendOp,
  setPluginAiCostCapOp,
} from "./ops/security/ai_calls.js";
import {
  listAiMemoryOp,
  listMemoryProposalsOp,
  proposeAiMemoryOp,
  reviewAiMemoryOp,
  setAiMemoryOp,
} from "./ops/security/ai_memory.js";
import { listAiPricingOp, setAiPricingOp } from "./ops/security/ai_pricing.js";
import {
  anyAiProviderConfiguredOp,
  clearAiProviderKeyOp,
  listAiProvidersOp,
  setAiProvidersOp,
} from "./ops/security/ai_providers.js";
import { auditByRequestIdOp } from "./ops/security/audit_by_request.js";
import {
  createMcpTokenOp,
  listMcpTokensOp,
  mcpSendChatOp,
  revokeMcpTokenOp,
} from "./ops/security/mcp_tokens.js";
import { getTelemetryOp, setTelemetryOp, testSendTelemetryOp } from "./ops/security/telemetry.js";
import {
  lookupLinksInModulesOp,
  pagesSeoAutofillOp,
  pagesSeoGetOp,
  pagesSeoListStaleOp,
  pagesSeoOptimizeManyOp,
  pagesSeoOptimizeOp,
  pagesSeoSetOp,
  rewriteModuleLinksOp,
  siteDefaultsGetSeoOp,
  siteDefaultsSetSeoOp,
} from "./ops/seo.js";
import { getSiteDefaultsOp, setSiteDefaultsOp } from "./ops/site_defaults.js";
import { getSiteSettingsOp, setSiteSettingsOp } from "./ops/site_settings.js";
import {
  listPinDefaultsOp,
  setEngagedSkillsOp,
  setPinDefaultsOp,
} from "./ops/skills/engagement.js";
import {
  listSkillProposalsOp,
  proposeSkillOp,
  reviewSkillProposalOp,
} from "./ops/skills/proposals.js";
import { archiveSkillOp, getSkillOp, listSkillsOp, setSkillOp } from "./ops/skills/skills.js";
import { archiveOlderThanOp } from "./ops/snapshots/archive.js";
import { getSnapshotWithEntitiesOp } from "./ops/snapshots/get.js";
import { moduleImpactOp } from "./ops/snapshots/impact.js";
import { listSnapshotsOp } from "./ops/snapshots/list.js";
import { revertModuleOp } from "./ops/snapshots/revert_module.js";
import { revertPageOp } from "./ops/snapshots/revert_page.js";
import { revertSiteOp } from "./ops/snapshots/revert_site.js";
import { revertTemplateOp } from "./ops/snapshots/revert_template.js";
import {
  deleteStructuredSetOp,
  getStructuredSetOp,
  listStructuredSetsOp,
  setStructuredSetOp,
} from "./ops/structured_sets.js";
import {
  aggregateAiCallsForSessionOp,
  createPendingSubagentRunOp,
  finishSubagentRunOp,
  gcSubagentSessionsOp,
  getSubagentRunOp,
  listSubagentRunsOp,
} from "./ops/subagents/runs.js";
import {
  deleteGlossaryEntryOp,
  listGlossaryOp,
  setGlossaryEntryOp,
} from "./ops/translation/glossary.js";
import {
  aggregateActiveTranslationJobsOp,
  cancelTranslationJobOp,
  createTranslationJobOp,
  getTranslationJobOp,
  listTranslationJobsOp,
  publishCompletedTranslationJobOp,
  revertTranslationJobOp,
  updateTranslationJobCapOp,
} from "./ops/translation/jobs.js";
import { translationModeOneOp } from "./ops/translation/mode_1.js";
import { translationDiffOp, translationModeTwoOp } from "./ops/translation/mode_2.js";
import {
  deleteStyleGuideOp,
  getStyleGuideOp,
  listStyleGuidesOp,
  setStyleGuideOp,
} from "./ops/translation/style_guide.js";
import { getUserPreferenceOp, setUserPreferenceOp } from "./ops/user_preferences.js";
import {
  completeOnboardingOp,
  createFirstOwnerOp,
  createUserOp,
  deleteUserOp,
  isSetupCompleteOp,
  listUsersOp,
  setUserRolesOp,
} from "./ops/users.js";

export function registerAdminOps(registry: OperationRegistry): void {
  registry.register(createFirstOwnerOp);
  registry.register(isSetupCompleteOp);
  registry.register(insertBootstrapTokenOp);
  registry.register(consumeBootstrapTokenOp);
  registry.register(anyBootstrapTokenIssuedOp);
  // P15 — provisioning outputs + DNS guidance.
  registry.register(setProvisioningOutputsOp);
  registry.register(getProvisioningOutputsOp);
  registry.register(verifyDnsRecordOp);
  registry.register(listUsersOp);
  registry.register(createUserOp);
  registry.register(setUserRolesOp);
  registry.register(deleteUserOp);
  registry.register(loginOp);
  registry.register(logoutOp);
  registry.register(resolveSessionOp);
  registry.register(listRolesOp);
  registry.register(createRoleOp);
  registry.register(deleteRoleOp);
  registry.register(updateRolePermissionsOp);
  // P3 content layer
  registry.register(listModulesOp);
  registry.register(getModuleOp);
  registry.register(createModuleOp);
  registry.register(updateModuleOp);
  registry.register(deleteModuleOp);
  registry.register(deleteModulesManyOp);
  registry.register(listTemplatesOp);
  registry.register(getTemplateOp);
  registry.register(createTemplateOp);
  registry.register(updateTemplateOp);
  registry.register(setTemplateLayoutOp);
  registry.register(deleteTemplateOp);
  registry.register(setTemplateBlocksOp);
  registry.register(listPagesOp);
  registry.register(getPageOp);
  registry.register(getPageWithModulesOp);
  registry.register(createPageOp);
  registry.register(updatePageOp);
  registry.register(setPageModulesOp);
  registry.register(duplicatePageOp);
  registry.register(changeTemplateOp);
  registry.register(deletePageOp);
  registry.register(renderPagePreviewOp);
  // P4 snapshots
  registry.register(listSnapshotsOp);
  registry.register(getSnapshotWithEntitiesOp);
  registry.register(moduleImpactOp);
  registry.register(revertSiteOp);
  registry.register(revertModuleOp);
  registry.register(revertTemplateOp);
  registry.register(revertPageOp);
  registry.register(archiveOlderThanOp);
  // P5 chat + AI memory + provider config + accounting
  registry.register(listChatSessionsOp);
  registry.register(createChatSessionOp);
  registry.register(getChatSessionOp);
  registry.register(renameChatSessionOp);
  registry.register(archiveChatSessionOp);
  registry.register(appendChatMessageOp);
  registry.register(markChatMessageInterruptedOp);
  registry.register(cacheToolResultOp);
  registry.register(lookupToolResultOp);
  registry.register(recordAiCallOp);
  registry.register(publishChatSessionOp);
  registry.register(listAiMemoryOp);
  registry.register(setAiMemoryOp);
  registry.register(proposeAiMemoryOp);
  registry.register(listMemoryProposalsOp);
  registry.register(reviewAiMemoryOp);
  registry.register(listAiProvidersOp);
  registry.register(setAiProvidersOp);
  registry.register(clearAiProviderKeyOp);
  registry.register(anyAiProviderConfiguredOp);
  registry.register(aggregateAiCallsOp);
  registry.register(aggregatePluginAiSpendOp);
  registry.register(setPluginAiCostCapOp);
  // P16 — multi-provider pricing + operation-type budgets.
  registry.register(listAiPricingOp);
  registry.register(setAiPricingOp);
  registry.register(listAiBudgetsOp);
  registry.register(setAiBudgetOp);
  registry.register(aiBudgetsStatusOp);
  // P16 — telemetry (off by default; opt-in toggles + payload preview)
  registry.register(getTelemetryOp);
  registry.register(setTelemetryOp);
  registry.register(testSendTelemetryOp);
  // P16 hardening — request_id correlation view
  registry.register(auditByRequestIdOp);
  // P17 PR4 — MCP server tokens + chat bridge
  registry.register(listMcpTokensOp);
  registry.register(createMcpTokenOp);
  registry.register(revokeMcpTokenOp);
  registry.register(mcpSendChatOp);
  // P6 deploy
  registry.register(listDeployTargetsOp);
  registry.register(listDeployRunsOp);
  registry.register(triggerDeployOp);
  registry.register(promoteDeployOp);
  registry.register(rollbackDeployOp);
  registry.register(updateDeployProgressOp);
  // P6.7 — live-edit overlay
  registry.register(getUserPreferenceOp);
  registry.register(setUserPreferenceOp);
  registry.register(createRedirectOp);
  registry.register(listRedirectsOp);
  registry.register(lookupRedirectOp);
  registry.register(deleteRedirectOp);
  registry.register(createRedirectsManyOp);
  registry.register(deleteRedirectsManyOp);
  registry.register(setStructuredSetOp);
  registry.register(getStructuredSetOp);
  registry.register(listStructuredSetsOp);
  registry.register(deleteStructuredSetOp);
  registry.register(setPinnedElementsOp);
  // P6.7.6 — layouts (site-wide chrome) + site_defaults singleton.
  registry.register(listLayoutsOp);
  registry.register(getLayoutOp);
  registry.register(createLayoutOp);
  registry.register(updateLayoutOp);
  registry.register(deleteLayoutOp);
  registry.register(getLayoutBlockModulesOp);
  registry.register(setLayoutBlocksOp);
  registry.register(setLayoutModulesOp);
  registry.register(getSiteDefaultsOp);
  registry.register(setSiteDefaultsOp);
  // P12 review pass — email transport singleton.
  registry.register(getEmailConfigOp);
  registry.register(setEmailConfigOp);
  // P14 — domains registry.
  registry.register(listDomainsOp);
  registry.register(addDomainOp);
  registry.register(removeDomainOp);
  registry.register(verifyDomainOp);
  registry.register(setDomainTlsStatusOp);
  // P14 — Site Import Wizard.
  registry.register(listImportRunsOp);
  registry.register(getImportRunOp);
  registry.register(createImportRunOp);
  registry.register(proposeImportRunOp);
  registry.register(listPendingImportProposalsOp);
  registry.register(executeImportProposalOp);
  registry.register(rejectImportProposalOp);
  registry.register(updateImportRunStatusOp);
  registry.register(updatePageDiffOp);
  registry.register(acknowledgeImportPageDiffOp);
  registry.register(writeExtractedPagesOp);
  registry.register(acceptImportedPageOp);
  registry.register(cleanupImportRunOp);
  registry.register(composeFromImportRunOp);
  // P13 — gateway hardening surface.
  registry.register(getGatewaySettingsOp);
  registry.register(setGatewaySettingsOp);
  registry.register(rotateCookieSecretOp);
  registry.register(listGatewayRequestsOp);
  registry.register(listGatewayAnalyticsOp);
  registry.register(setRateLimitOverrideOp);
  registry.register(proposeRateLimitOp);
  registry.register(listPendingRateLimitProposalsOp);
  registry.register(executeRateLimitProposalOp);
  registry.register(rejectRateLimitProposalOp);
  // P13 ideas-pass — rate-limit profiles.
  registry.register(listRateLimitProfilesOp);
  registry.register(setRateLimitProfileOp);
  // P13 — A/B experiments.
  registry.register(createExperimentOp);
  registry.register(activateExperimentOp);
  registry.register(completeExperimentOp);
  registry.register(listExperimentsOp);
  registry.register(getExperimentResultsOp);
  registry.register(recordAssignmentOp);
  // P6.6b — UX polish surface.
  registry.register(aggregateNotificationsOp);
  registry.register(completeOnboardingOp);
  registry.register(listBranchEditedModulesOp);
  // P7 — media library.
  registry.register(mediaUploadOp);
  registry.register(mediaListOp);
  registry.register(mediaGetOp);
  registry.register(mediaUpdateAltOp);
  registry.register(mediaDeleteOp);
  registry.register(mediaDeleteManyOp);
  registry.register(mediaRecordUsageOp);
  registry.register(mediaRecentForAiOp);
  registry.register(mediaListUsagesOp);
  registry.register(mediaGetSettingsOp);
  registry.register(setMediaCdnOp);
  // P7 optimizations — focal-point/crops, processing status, alt proposals.
  registry.register(setFocalPointOp);
  registry.register(addCropOp);
  registry.register(deleteCropOp);
  registry.register(listCropsOp);
  registry.register(getProcessingStatusOp);
  registry.register(proposeAltOp);
  registry.register(listAltProposalsOp);
  registry.register(reviewAltProposalOp);
  // P8 — SEO sidecar + slug-change link rewriter + site SEO defaults.
  registry.register(pagesSeoGetOp);
  registry.register(pagesSeoSetOp);
  registry.register(pagesSeoAutofillOp);
  registry.register(pagesSeoOptimizeOp);
  registry.register(pagesSeoOptimizeManyOp);
  registry.register(pagesSeoListStaleOp);
  registry.register(siteDefaultsGetSeoOp);
  registry.register(siteDefaultsSetSeoOp);
  registry.register(lookupLinksInModulesOp);
  registry.register(rewriteModuleLinksOp);
  // P9 — locale registry + propose/execute split + site_settings toggle.
  registry.register(listLocalesOp);
  registry.register(getLocaleOp);
  registry.register(proposeCreateLocaleOp);
  registry.register(proposeDeleteLocaleOp);
  registry.register(proposeSetDefaultLocaleOp);
  registry.register(proposeUpdateStrategyOp);
  registry.register(listPendingLocaleProposalsOp);
  registry.register(executeLocaleProposalOp);
  registry.register(rejectLocaleProposalOp);
  registry.register(getSiteSettingsOp);
  registry.register(setSiteSettingsOp);
  registry.register(translationStatusMatrixOp);
  // P10 — translation surface (glossary + style guide + Mode 1/2 + bulk jobs).
  registry.register(listGlossaryOp);
  registry.register(setGlossaryEntryOp);
  registry.register(deleteGlossaryEntryOp);
  registry.register(listStyleGuidesOp);
  registry.register(getStyleGuideOp);
  registry.register(setStyleGuideOp);
  registry.register(deleteStyleGuideOp);
  registry.register(translationModeOneOp);
  registry.register(translationModeTwoOp);
  registry.register(translationDiffOp);
  registry.register(createTranslationJobOp);
  registry.register(listTranslationJobsOp);
  registry.register(getTranslationJobOp);
  registry.register(aggregateActiveTranslationJobsOp);
  registry.register(cancelTranslationJobOp);
  registry.register(updateTranslationJobCapOp);
  registry.register(revertTranslationJobOp);
  registry.register(publishCompletedTranslationJobOp);
  // P10A — skills system.
  registry.register(listSkillsOp);
  registry.register(getSkillOp);
  registry.register(setSkillOp);
  registry.register(archiveSkillOp);
  registry.register(proposeSkillOp);
  registry.register(listSkillProposalsOp);
  registry.register(reviewSkillProposalOp);
  registry.register(listPinDefaultsOp);
  registry.register(setPinDefaultsOp);
  registry.register(setEngagedSkillsOp);
  // P10.5 — subagent runs metadata + cost aggregation.
  registry.register(createPendingSubagentRunOp);
  registry.register(finishSubagentRunOp);
  registry.register(listSubagentRunsOp);
  registry.register(getSubagentRunOp);
  registry.register(aggregateAiCallsForSessionOp);
  registry.register(gcSubagentSessionsOp);
  // P11 — plugin host registry + lifecycle.
  registry.register(listPluginsOp);
  registry.register(getPluginOp);
  registry.register(listPendingPluginsOp);
  registry.register(submitPluginOp);
  registry.register(preparePluginActivationOp);
  registry.register(activatePluginOp);
  registry.register(disablePluginOp);
  registry.register(rejectPluginOp);
  registry.register(revalidatePluginOp);
  // v0.2.18 — comments long-term archive (cms_public is now ephemeral
  // after moderation; long-term store + static-render reads land here).
  registry.register(commentArchiveInsertOp);
  registry.register(commentArchiveListForPageOp);
}
