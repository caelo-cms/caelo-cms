// SPDX-License-Identifier: MPL-2.0

import type { OperationRegistry } from "@caelo-cms/query-api";
import {
  executeAiProvidersProposalOp,
  listPendingAiProvidersProposalsOp,
  proposeAiProvidersClearKeyOp,
  proposeAiProvidersSetOp,
  rejectAiProvidersProposalOp,
} from "./ops/ai_providers_pending.js";
import { loginOp, logoutOp, resolveSessionOp } from "./ops/auth.js";
import { cancelProposalOp } from "./ops/cancel_proposal.js";
import {
  appendChatMessageOp,
  cacheToolResultOp,
  lookupToolResultOp,
  markChatMessageInterruptedOp,
  recordAiCallOp,
} from "./ops/chat/messages.js";
import { mergeChatToMainOp, publishChatSessionOp } from "./ops/chat/publish.js";
import {
  archiveChatSessionOp,
  countBranchChangesOp,
  createChatSessionOp,
  getChatBranchIdOp,
  getChatSessionOp,
  listActivePagesOp,
  listBranchEditedEntitiesOp,
  listBranchEditedModulesOp,
  listChatSessionsOp,
  listOpenChatsWithPendingOp,
  renameChatSessionOp,
  setChatExtendedThinkingOp,
  setPinnedElementsOp,
} from "./ops/chat/sessions.js";
import {
  listPendingChangesOp,
  stageChatChangesOp,
  unstageChatChangesOp,
} from "./ops/chat/stage.js";
import { summarizeChatOp } from "./ops/chat/summarize.js";
import {
  createContentInstanceOp,
  deleteContentInstanceOp,
  forkPlacementContentOp,
  getContentInstanceOp,
  listContentInstancesOp,
  setContentInstanceValuesOp,
  setPlacementContentOp,
} from "./ops/content/content-instances.js";
import {
  executeLayoutProposalOp,
  listPendingLayoutProposalsOp,
  proposeLayoutCreateOp,
  proposeLayoutDeleteOp,
  proposeLayoutSetBlocksOp,
  proposeLayoutUpdateOp,
  rejectLayoutProposalOp,
} from "./ops/content/layout_pending.js";
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
  listModulesUsageOp,
  updateModuleOp,
  updateModulesManyOp,
} from "./ops/content/modules.js";
import {
  getPageModuleContentOp,
  setPageModuleContentOp,
} from "./ops/content/page-module-content.js";
import {
  changeTemplateOp,
  createPageOp,
  deletePageOp,
  deletePagesManyOp,
  duplicatePageOp,
  getPageOp,
  getPageWithModulesOp,
  listPagesOp,
  setPageModulesOp,
  setPageStatusOp,
  setPagesStatusManyOp,
  updatePageOp,
  updatePagesManyOp,
} from "./ops/content/pages.js";
import { renderPagePreviewOp } from "./ops/content/preview.js";
import { setTemplateBlocksOp } from "./ops/content/template_blocks.js";
import {
  executeTemplateProposalOp,
  listPendingTemplateProposalsOp,
  proposeTemplateDeleteOp,
  proposeTemplateUpdateOp,
  rejectTemplateProposalOp,
} from "./ops/content/template_pending.js";
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
  executeDeployProposalOp,
  listPendingDeployProposalsOp,
  proposeDeployPromoteOp,
  proposeDeployRollbackOp,
  rejectDeployProposalOp,
} from "./ops/deploy_pending.js";
import {
  executeDomainProposalOp,
  listPendingDomainProposalsOp,
  proposeDomainAddOp,
  proposeDomainRemoveOp,
  rejectDomainProposalOp,
} from "./ops/domain_pending.js";
import {
  addDomainOp,
  listDomainsOp,
  removeDomainOp,
  setDomainTlsStatusOp,
  verifyDomainOp,
} from "./ops/domains.js";
import { getEmailConfigOp, setEmailConfigOp } from "./ops/email_config.js";
import {
  executeEmailConfigProposalOp,
  listPendingEmailConfigProposalsOp,
  proposeEmailConfigSetOp,
  rejectEmailConfigProposalOp,
} from "./ops/email_config_pending.js";
import {
  executeExperimentProposalOp,
  listPendingExperimentProposalsOp,
  proposeExperimentActivateOp,
  proposeExperimentCompleteOp,
  rejectExperimentProposalOp,
} from "./ops/experiment_pending.js";
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
  executeMcpTokenProposalOp,
  listPendingMcpTokenProposalsOp,
  proposeMcpTokenCreateOp,
  proposeMcpTokenRevokeOp,
  rejectMcpTokenProposalOp,
} from "./ops/mcp_token_pending.js";
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
import { listPendingProposalsAcrossDomainsOp } from "./ops/pending_proposals.js";
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
import {
  executeRoleProposalOp,
  listPendingRoleProposalsOp,
  proposeRoleCreateOp,
  proposeRoleDeleteOp,
  proposeRoleUpdatePermissionsOp,
  rejectRoleProposalOp,
} from "./ops/role_pending.js";
import { createRoleOp, deleteRoleOp, listRolesOp, updateRolePermissionsOp } from "./ops/roles.js";
import { aiBudgetsStatusOp, listAiBudgetsOp, setAiBudgetOp } from "./ops/security/ai_budgets.js";
import {
  aggregateAiCallsOp,
  aggregatePluginAiSpendOp,
  setPluginAiCostCapOp,
} from "./ops/security/ai_calls.js";
import { aggregateAuditByOpPrefixOp } from "./ops/security/ai_calls_by_op.js";
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
import {
  executeSnapshotRevertProposalOp,
  listPendingSnapshotRevertProposalsOp,
  proposeRevertModuleOp,
  proposeRevertPageOp,
  proposeRevertSiteOp,
  proposeRevertTemplateOp,
  rejectSnapshotRevertProposalOp,
} from "./ops/snapshot_pending.js";
import { archiveOlderThanOp } from "./ops/snapshots/archive.js";
import { getSnapshotWithEntitiesOp } from "./ops/snapshots/get.js";
import { moduleImpactOp } from "./ops/snapshots/impact.js";
import { listSnapshotsOp } from "./ops/snapshots/list.js";
import { publishImpactPagesOp } from "./ops/snapshots/publish_impact_pages.js";
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
  duplicateThemeOp,
  exportThemeDtcgOp,
  getActiveThemeOp,
  getThemeOp,
  importThemeDtcgOp,
  listThemesOp,
  setThemeAssetOp,
  updateThemeTokensOp,
} from "./ops/themes.js";
import {
  executeThemeProposalOp,
  listPendingThemeProposalsOp,
  proposeActivateThemeOp,
  proposeCreateThemeOp,
  proposeDeleteThemeOp,
  rejectThemeProposalOp,
} from "./ops/themes_pending.js";
import {
  aggregateAiCallsForSessionOp,
  createPendingSubagentRunOp,
  finishSubagentRunOp,
  gcSubagentSessionsOp,
  getSubagentRunOp,
  listSubagentRunsOp,
} from "./ops/subagents/runs.js";
import {
  listPendingToolApprovalsOp,
  markToolApprovalResultOp,
  queueToolApprovalOp,
  readToolApprovalForExecuteOp,
  rejectToolApprovalOp,
} from "./ops/tool_approvals.js";
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
import {
  executeUserProposalOp,
  listPendingUserProposalsOp,
  proposeUserCreateOp,
  proposeUserDeleteOp,
  proposeUserSetRolesOp,
  rejectUserProposalOp,
} from "./ops/user_pending.js";
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
  // v0.2.21 — users propose/execute pairs. AI proposes via
  // users.propose_*; Owner approves at /security/users/pending which
  // calls users.execute_proposal (human-only) → runs the underlying
  // users.{create,set_roles,delete} op. Passwords on create are
  // server-generated at execute time; AI never handles credentials.
  registry.register(proposeUserCreateOp);
  registry.register(proposeUserSetRolesOp);
  registry.register(proposeUserDeleteOp);
  registry.register(executeUserProposalOp);
  registry.register(rejectUserProposalOp);
  registry.register(listPendingUserProposalsOp);
  registry.register(loginOp);
  registry.register(logoutOp);
  registry.register(resolveSessionOp);
  registry.register(listRolesOp);
  registry.register(createRoleOp);
  registry.register(deleteRoleOp);
  registry.register(updateRolePermissionsOp);
  // v0.2.22 — roles propose/execute pairs. AI proposes via roles.propose_*;
  // Owner approves at /security/roles/pending which calls
  // roles.execute_proposal (human-only) → underlying roles.{create,
  // update_permissions, delete} op. Built-in role protection still
  // enforced at the underlying op layer.
  registry.register(proposeRoleCreateOp);
  registry.register(proposeRoleUpdatePermissionsOp);
  registry.register(proposeRoleDeleteOp);
  registry.register(executeRoleProposalOp);
  registry.register(rejectRoleProposalOp);
  registry.register(listPendingRoleProposalsOp);
  // P3 content layer
  registry.register(listModulesOp);
  registry.register(listModulesUsageOp);
  registry.register(getModuleOp);
  registry.register(createModuleOp);
  registry.register(updateModuleOp);
  registry.register(updateModulesManyOp);
  registry.register(deleteModuleOp);
  registry.register(deleteModulesManyOp);
  registry.register(listTemplatesOp);
  registry.register(getTemplateOp);
  registry.register(createTemplateOp);
  registry.register(updateTemplateOp);
  registry.register(setTemplateLayoutOp);
  registry.register(deleteTemplateOp);
  registry.register(setTemplateBlocksOp);
  // v0.2.28 — templates propose/execute pairs (update / delete).
  // create + set_layout are already AI-direct; this gate covers the
  // higher-blast-radius update (re-renders all bound pages) and
  // delete (orphans them) paths via /security/templates/pending.
  registry.register(proposeTemplateUpdateOp);
  registry.register(proposeTemplateDeleteOp);
  registry.register(executeTemplateProposalOp);
  registry.register(rejectTemplateProposalOp);
  registry.register(listPendingTemplateProposalsOp);
  registry.register(listPagesOp);
  registry.register(getPageOp);
  registry.register(getPageWithModulesOp);
  registry.register(createPageOp);
  registry.register(updatePageOp);
  registry.register(setPageStatusOp);
  registry.register(setPagesStatusManyOp);
  registry.register(setPageModulesOp);
  registry.register(getPageModuleContentOp);
  registry.register(setPageModuleContentOp);
  // v0.12.0 — content_instances + placement binding ops.
  registry.register(listContentInstancesOp);
  registry.register(getContentInstanceOp);
  registry.register(createContentInstanceOp);
  registry.register(setContentInstanceValuesOp);
  registry.register(deleteContentInstanceOp);
  registry.register(setPlacementContentOp);
  registry.register(forkPlacementContentOp);
  registry.register(duplicatePageOp);
  registry.register(changeTemplateOp);
  registry.register(deletePageOp);
  // v0.2.33 — bulk variants per CLAUDE.md §11.
  registry.register(deletePagesManyOp);
  registry.register(updatePagesManyOp);
  registry.register(renderPagePreviewOp);
  // P4 snapshots
  registry.register(listSnapshotsOp);
  registry.register(getSnapshotWithEntitiesOp);
  registry.register(moduleImpactOp);
  registry.register(publishImpactPagesOp);
  registry.register(revertSiteOp);
  registry.register(revertModuleOp);
  registry.register(revertTemplateOp);
  registry.register(revertPageOp);
  registry.register(archiveOlderThanOp);
  // v0.2.23 — snapshot-revert propose/execute pairs (site / page /
  // template / module). AI proposes via snapshots.propose_revert_*;
  // Owner approves at /security/snapshots/pending which calls
  // snapshots.execute_proposal (human-only) → underlying revert op.
  // Highest blast-radius surface — site reverts can rewind hundreds
  // of pages, so the preview surfaces affected entity counts.
  registry.register(proposeRevertSiteOp);
  registry.register(proposeRevertPageOp);
  registry.register(proposeRevertTemplateOp);
  registry.register(proposeRevertModuleOp);
  registry.register(executeSnapshotRevertProposalOp);
  registry.register(rejectSnapshotRevertProposalOp);
  registry.register(listPendingSnapshotRevertProposalsOp);
  // v0.6.0 W5 — generic tool-approval gate (needsApproval predicate
  // on ToolDefinitionWithHandler). Queue + atomic-claim execute +
  // reject + list_pending — same shape as snapshot_pending but
  // tool-name-keyed instead of domain-keyed.
  registry.register(queueToolApprovalOp);
  registry.register(readToolApprovalForExecuteOp);
  registry.register(markToolApprovalResultOp);
  registry.register(rejectToolApprovalOp);
  registry.register(listPendingToolApprovalsOp);
  // P5 chat + AI memory + provider config + accounting
  registry.register(listChatSessionsOp);
  registry.register(createChatSessionOp);
  registry.register(getChatSessionOp);
  registry.register(getChatBranchIdOp);
  registry.register(renameChatSessionOp);
  registry.register(archiveChatSessionOp);
  registry.register(appendChatMessageOp);
  registry.register(markChatMessageInterruptedOp);
  registry.register(cacheToolResultOp);
  registry.register(lookupToolResultOp);
  registry.register(recordAiCallOp);
  registry.register(publishChatSessionOp);
  registry.register(mergeChatToMainOp);
  registry.register(listPendingChangesOp);
  registry.register(stageChatChangesOp);
  registry.register(unstageChatChangesOp);
  registry.register(listAiMemoryOp);
  registry.register(setAiMemoryOp);
  registry.register(proposeAiMemoryOp);
  registry.register(listMemoryProposalsOp);
  registry.register(reviewAiMemoryOp);
  registry.register(listAiProvidersOp);
  registry.register(setAiProvidersOp);
  registry.register(clearAiProviderKeyOp);
  registry.register(anyAiProviderConfiguredOp);
  // v0.2.26 — ai_providers propose/execute pairs (set / clear_key).
  // AI proposes config + isActive; Owner pastes the apiKey inline at
  // approve time at /security/ai/pending. Reuses the secret-at-approve
  // pattern from email_config (v0.2.25) — the apiKey never lands in
  // the proposal payload.
  registry.register(proposeAiProvidersSetOp);
  registry.register(proposeAiProvidersClearKeyOp);
  registry.register(executeAiProvidersProposalOp);
  registry.register(rejectAiProvidersProposalOp);
  registry.register(listPendingAiProvidersProposalsOp);
  registry.register(aggregateAiCallsOp);
  registry.register(aggregatePluginAiSpendOp);
  registry.register(setPluginAiCostCapOp);
  // v0.2.40 — per-domain AI activity attribution. Counts AI-attributed
  // audit_events per op-prefix so the operator can see where the AI
  // is spending its time (and which domains have high failure rates,
  // a signal to tune tool descriptions / pre-flight).
  registry.register(aggregateAuditByOpPrefixOp);
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
  // v0.2.27 — mcp_tokens propose/execute pairs (create / revoke).
  // AI proposes new tokens by displayName + cap; the Owner approves
  // at /security/mcp/pending and the plaintext token is generated
  // server-side and shown ONCE in the response banner. Same shape
  // as users.execute_proposal returning the temp password.
  registry.register(proposeMcpTokenCreateOp);
  registry.register(proposeMcpTokenRevokeOp);
  registry.register(executeMcpTokenProposalOp);
  registry.register(rejectMcpTokenProposalOp);
  registry.register(listPendingMcpTokenProposalsOp);
  // P6 deploy
  registry.register(listDeployTargetsOp);
  registry.register(listDeployRunsOp);
  registry.register(triggerDeployOp);
  registry.register(promoteDeployOp);
  registry.register(rollbackDeployOp);
  registry.register(updateDeployProgressOp);
  // v0.2.19 — propose/execute pair for promote + rollback. AI proposes
  // (human + ai + system); Owner approves at /security/deployments/pending
  // which calls execute_proposal (human + system) → runs the underlying op.
  registry.register(proposeDeployPromoteOp);
  registry.register(proposeDeployRollbackOp);
  registry.register(executeDeployProposalOp);
  registry.register(rejectDeployProposalOp);
  registry.register(listPendingDeployProposalsOp);
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
  // v0.11.0 — themes primitive (#45). Routine read + write ops plus
  // the §11.A propose/execute gate for create / activate / delete.
  registry.register(listThemesOp);
  registry.register(getThemeOp);
  registry.register(getActiveThemeOp);
  registry.register(updateThemeTokensOp);
  registry.register(setThemeAssetOp);
  registry.register(duplicateThemeOp);
  registry.register(importThemeDtcgOp);
  registry.register(exportThemeDtcgOp);
  registry.register(proposeCreateThemeOp);
  registry.register(proposeActivateThemeOp);
  registry.register(proposeDeleteThemeOp);
  registry.register(executeThemeProposalOp);
  registry.register(rejectThemeProposalOp);
  registry.register(listPendingThemeProposalsOp);
  registry.register(setPinnedElementsOp);
  registry.register(setChatExtendedThinkingOp);
  // P6.7.6 — layouts (site-wide chrome) + site_defaults singleton.
  registry.register(listLayoutsOp);
  registry.register(getLayoutOp);
  registry.register(createLayoutOp);
  registry.register(updateLayoutOp);
  registry.register(deleteLayoutOp);
  registry.register(getLayoutBlockModulesOp);
  registry.register(setLayoutBlocksOp);
  registry.register(setLayoutModulesOp);
  // v0.2.20 — layouts propose/execute pairs. AI proposes via
  // layouts.propose_*; Owner approves at /security/layouts/pending
  // which calls layouts.execute_proposal (human-only) → runs the
  // underlying layouts.{create,update,delete,set_blocks} op.
  registry.register(proposeLayoutCreateOp);
  registry.register(proposeLayoutUpdateOp);
  registry.register(proposeLayoutDeleteOp);
  registry.register(proposeLayoutSetBlocksOp);
  registry.register(executeLayoutProposalOp);
  registry.register(rejectLayoutProposalOp);
  registry.register(listPendingLayoutProposalsOp);
  registry.register(getSiteDefaultsOp);
  registry.register(setSiteDefaultsOp);
  // P12 review pass — email transport singleton.
  registry.register(getEmailConfigOp);
  registry.register(setEmailConfigOp);
  // v0.2.25 — email_config propose/execute pair. AI proposes
  // transport+fromAddress+config-without-secrets; Owner supplies the
  // smtp password / resend apiKey / SES key inline at approve time
  // via /security/email/pending. Introduces the secret-at-approve
  // pattern that ai_providers and mcp_tokens reuse later.
  registry.register(proposeEmailConfigSetOp);
  registry.register(executeEmailConfigProposalOp);
  registry.register(rejectEmailConfigProposalOp);
  registry.register(listPendingEmailConfigProposalsOp);
  // P14 — domains registry.
  registry.register(listDomainsOp);
  registry.register(addDomainOp);
  registry.register(removeDomainOp);
  registry.register(verifyDomainOp);
  registry.register(setDomainTlsStatusOp);
  // v0.2.30 — domains propose/execute pairs (add / remove). AI
  // proposes via domains.propose_*; Owner approves at
  // /security/domains/pending. domains.verify is widened to AI in the
  // same release (diagnostic, no destructive side effect).
  registry.register(proposeDomainAddOp);
  registry.register(proposeDomainRemoveOp);
  registry.register(executeDomainProposalOp);
  registry.register(rejectDomainProposalOp);
  registry.register(listPendingDomainProposalsOp);
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
  // v0.2.24 — experiments propose/execute pairs for the live-traffic
  // transitions (activate / complete). create stays AI-direct since it
  // only mints a draft; activate flips production traffic on, and
  // complete records the winner — both Owner-gated through the queue
  // at /security/experiments/pending.
  registry.register(proposeExperimentActivateOp);
  registry.register(proposeExperimentCompleteOp);
  registry.register(executeExperimentProposalOp);
  registry.register(rejectExperimentProposalOp);
  registry.register(listPendingExperimentProposalsOp);
  // P6.6b — UX polish surface.
  registry.register(aggregateNotificationsOp);
  // v0.2.32 — cross-domain pending proposals aggregator. Used by the
  // chat-runner's `## Pending proposals` system-prompt block (so the
  // AI doesn't re-propose what's already queued) and by the AppShell
  // bell badge (cross-domain count of "things waiting on you").
  registry.register(listPendingProposalsAcrossDomainsOp);
  // v0.2.37 — cancel a pending proposal the AI queued in error
  // (or the human Owner did). Restricted to the actor who proposed it
  // by the WHERE clause; doesn't grant cross-actor cancel rights.
  registry.register(cancelProposalOp);
  registry.register(completeOnboardingOp);
  registry.register(listBranchEditedModulesOp);
  registry.register(listBranchEditedEntitiesOp);
  registry.register(countBranchChangesOp);
  // v0.5.8 — per-page chat gate companion: list pages with an open chat.
  registry.register(listActivePagesOp);
  // v0.8.0 — cross-chat awareness banner data for the /edit toolbar.
  registry.register(listOpenChatsWithPendingOp);
  // v0.5.20 — per-chat completion view (powers /content/chat/[id]/summary).
  registry.register(summarizeChatOp);
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
