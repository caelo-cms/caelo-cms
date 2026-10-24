// SPDX-License-Identifier: MPL-2.0

import {
  findFontsOp,
  importFontOp,
  inspectFontOp,
  readFontOp,
  resolveFontOp,
} from "@caelo-cms/font-service";
// The gateway runs these too, so they live in plugin-host (gateway-ops.ts, #634).
import { commentArchiveListForPageOp } from "@caelo-cms/plugin-host";
import type { OperationRegistry } from "@caelo-cms/query-api";
import {
  bugClustersToRefreshOp,
  bugForwardingIdentityOp,
  claimDueBugReportsOp,
  getBugForwardingOp,
  markBugIntakeRegisteredOp,
  previewBugForwardingOp,
  queueUnsentBugReportsOp,
  recordBugClusterStatusOp,
  recordBugForwardResultOp,
  setBugForwardingOp,
} from "./ops/ai/bug-forwarding.js";
import { createBugReportOp, listBugReportsOp } from "./ops/ai/bug-reports.js";
import { logModuleizeAttemptOp } from "./ops/ai/moduleize_log.js";
import {
  executeAiProvidersProposalOp,
  listPendingAiProvidersProposalsOp,
  proposeAiProvidersClearKeyOp,
  proposeAiProvidersSetOp,
  rejectAiProvidersProposalOp,
} from "./ops/ai_providers_pending.js";
import {
  issueOwnerResetOp,
  loginOp,
  logoutOp,
  requestPasswordResetOp,
  resetPasswordOp,
  resolveSessionOp,
} from "./ops/auth.js";
import { cancelProposalOp } from "./ops/cancel_proposal.js";
import {
  allowExternalAgentOp,
  cancelAgentsOp,
  finishAgentRunOp,
  getAgentStopEpochOp,
  heartbeatAgentRunOp,
  listAgentRunsOp,
  registerAgentRunOp,
  touchExternalAgentOp,
} from "./ops/chat/agent-runs.js";
import { discardChatBranchOp } from "./ops/chat/discard.js";
import {
  checkBranchAccessOp,
  finalizeDraftStageOp,
  isolateSessionOp,
  mergeDraftToMainOp,
  undoChatChangesOp,
} from "./ops/chat/draft-ops.js";
import { listForeignLocksOp } from "./ops/chat/foreign-locks.js";
import {
  appendChatMessageOp,
  cacheToolResultOp,
  lookupToolResultOp,
  markChatMessageInterruptedOp,
  recordAiCallOp,
  setResponseMessagesOp,
} from "./ops/chat/messages.js";
import { drainTakeoverNoticesOp, listOpenChangesOp } from "./ops/chat/open-changes.js";
import { finalizeStageOp, mergeChatToMainOp, publishChatSessionOp } from "./ops/chat/publish.js";
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
import { pinSkillsIndexOp } from "./ops/chat/skills-index-pin.js";
import {
  listPendingChangesOp,
  stageChatChangesOp,
  unstageChatChangesOp,
} from "./ops/chat/stage.js";
import { summarizeChatOp } from "./ops/chat/summarize.js";
import {
  claimTurnApprovalsOp,
  decideTurnApprovalOp,
  listTurnApprovalsOp,
  mcpGetChatApprovalStateOp,
  recordTurnApprovalsOp,
  supersedeTurnApprovalsOp,
} from "./ops/chat/turn-approvals.js";
import {
  acquireChatTurnLeaseOp,
  releaseChatTurnLeaseOp,
  renewChatTurnLeaseOp,
} from "./ops/chat/turn-leases.js";
import { buildPageOp } from "./ops/content/build-page.js";
import {
  createContentInstanceOp,
  createContentInstancesManyOp,
  deleteContentInstanceOp,
  forkPlacementContentOp,
  getContentInstanceOp,
  listContentInstancesOp,
  setContentInstanceValuesOp,
  setPlacementContentOp,
} from "./ops/content/content-instances.js";
import {
  deleteContentInstancesManyOp,
  setContentInstanceValuesManyOp,
} from "./ops/content/content-instances-bulk.js";
import { refreshCurrentPathOp } from "./ops/content/current-path.js";
import { setHomePageOp } from "./ops/content/home-page.js";
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
import { canonicaliseLinkValuesOp } from "./ops/content/link-canonicalise.js";
import { checkReferencesOp } from "./ops/content/link-integrity.js";
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
import { setNotFoundPageOp } from "./ops/content/not-found-page.js";
import {
  getPageModuleContentOp,
  listPageModuleContentOp,
  setPageModuleContentManyOp,
  setPageModuleContentOp,
} from "./ops/content/page-module-content.js";
import { patchPageModuleFieldsOp } from "./ops/content/page-module-patch.js";
import { movePagesManyOp, planPageMovesOp } from "./ops/content/page-moves.js";
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
import { resolvePublicUrlsOp } from "./ops/content/public-urls.js";
import { listSharedContentOp } from "./ops/content/shared-content.js";
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
import {
  executeUrlMigrationOp,
  listUrlMigrationPendingOp,
  proposeUrlMigrationOp,
  rejectUrlMigrationOp,
} from "./ops/content/url_migrations.js";
import { issueCredentialOp, listCredentialHandoffsOp } from "./ops/credential_handoffs.js";
import {
  listDeployRunsOp,
  listDeployTargetsOp,
  promoteDeployOp,
  refreshStagingPreviewOp,
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
import { beginDeployRunOp } from "./ops/deploy-run-lifecycle.js";
import { hostingStatusOp, reconnectHostingDomainOp } from "./ops/domain_hosting.js";
import {
  executeDomainProposalOp,
  listPendingDomainProposalsOp,
  proposeDomainAddOp,
  proposeDomainReconnectOp,
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
import { getEmailConfigOp, sendTestEmailOp, setEmailConfigOp } from "./ops/email_config.js";
import {
  executeEmailConfigProposalOp,
  listPendingEmailConfigProposalsOp,
  proposeEmailConfigSetOp,
  rejectEmailConfigProposalOp,
} from "./ops/email_config_pending.js";
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
  addGenesisDraftOp,
  listGenesisDraftsOp,
  renderDesignDraftOp,
  selectGenesisDraftOp,
} from "./ops/genesis.js";
import {
  imageRequestsFinishOp,
  imageRequestsMarkUncertainOp,
  imageRequestsReadOp,
  imageRequestsReserveOp,
} from "./ops/image_requests.js";
import { importMediaUrlsOp, listPageAssetsOp } from "./ops/import_media.js";
import {
  acceptImportedPageOp,
  acceptImportedPagesOp,
  addImportPageNotesOp,
  checkImportPageInventoryOp,
  cleanupImportRunOp,
  createImportRunOp,
  detectImportBoilerplateOp,
  executeImportProposalOp,
  getImportPageGistOp,
  getImportPageScreenshotKeysOp,
  getImportRunOp,
  getImportRunReportOp,
  getRunCalibrationOp,
  getRunCostOp,
  getSessionBudgetStateOp,
  listImportPagesOp,
  listImportRunsOp,
  listPendingImportProposalsOp,
  logImportRunEventOp,
  logImportRunEventsOp,
  proposeImportRunOp,
  recordBudgetGateEventOp,
  rejectImportProposalOp,
  setCostCeilingOp,
  setPageCapturesByUrlOp,
  setRunDesignTokensOp,
  updateImportRunStatusOp,
  updatePageCaptureOp,
  writeExtractedPagesOp,
} from "./ops/imports.js";
import {
  getLinkMigrationReportOp,
  migrateLinksToReferencesOp,
  revertLinkMigrationOp,
} from "./ops/links.js";
import { resolveImportLinksOp } from "./ops/links-import.js";
import { listMcpApprovalHandoffsOp } from "./ops/mcp_approval_handoffs.js";
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
  mediaRecordUsageOp,
  mediaSetSourceOp,
  mediaSetVisibilityOp,
  mediaUpdateAltOp,
  mediaUploadOp,
  proposeAltOp,
  reviewAltProposalOp,
  setFocalPointOp,
  setMediaCdnOp,
} from "./ops/media.js";
import { ensureActiveFaviconRenditionOp } from "./ops/media_favicon.js";
import { mediaListMissingFilesOp } from "./ops/media_missing.js";
import { regenerateMediaVariantsOp } from "./ops/media_regenerate.js";
import {
  mediaSetSourceManyOp,
  mediaSetVisibilityManyOp,
  mediaUpdateAltManyOp,
} from "./ops/media-bulk.js";
import { aggregateNotificationsOp } from "./ops/notifications.js";
import {
  executeOwnerSettingsProposalOp,
  listPendingOwnerSettingsProposalsOp,
  proposeSetAiBudgetOp,
  proposeSetAiPricingOp,
  proposeSetGatewaySettingsOp,
  proposeSetTranslationModelOp,
  rejectOwnerSettingsProposalOp,
} from "./ops/owner_settings_pending.js";
import {
  proposeRotateGatewayCookieSecretOp,
  proposeSetPluginAiCostCapOp,
} from "./ops/owner_settings_security.js";
import {
  proposeRotateStagingCredentialsOp,
  proposeSetStagingAccessOp,
  proposeSetStagingHostOp,
} from "./ops/owner_settings_staging.js";
import { anyBootstrapTokenIssuedOp, insertBootstrapTokenOp } from "./ops/owner-bootstrap-tokens.js";
import { appendPageLogOp, listPageLogOp } from "./ops/page_log.js";
import { listPendingProposalsAcrossDomainsOp } from "./ops/pending_proposals.js";
import { appliedAdminMigrationsOp, appliedPublicMigrationsOp } from "./ops/platform_health.js";
import { platformUpdatesAgentStatusOp } from "./ops/platform-update-agent.js";
import {
  platformUpdatePolicyGetOp,
  platformUpdatePolicyPauseOp,
  platformUpdatePolicyResumeOp,
  platformUpdatePolicySetOp,
} from "./ops/platform-update-policy.js";
import {
  platformUpdatesCancelOp,
  platformUpdatesContinueOp,
  platformUpdatesGetOp,
  platformUpdatesListOp,
  platformUpdatesRecordTriggerOp,
  platformUpdatesRequestOp,
  platformUpdatesSupersedeStaleOp,
} from "./ops/platform-update-requests.js";
import {
  platformUpdatesNotificationClaimOp,
  platformUpdatesNotificationFinishOp,
  platformUpdatesSchedulerStatusOp,
  platformUpdatesSchedulerTickOp,
} from "./ops/platform-update-scheduler.js";
import { platformUpdatesSkipScheduledOp } from "./ops/platform-update-skip.js";
import { platformUpdateStatusOp, platformUpdatesCheckNowOp } from "./ops/platform-updates.js";
import { executePluginActivationOp, proposePluginActivationOp } from "./ops/plugins/activation.js";
import {
  listPluginCapabilityGrantsOp,
  proposeRevokePluginCapabilityOp,
} from "./ops/plugins/capability_proposals.js";
import { commentArchiveInsertOp } from "./ops/plugins/comment_archive.js";
import {
  approvePluginInstallationOp,
  finalizePluginInstallationOp,
  getApprovedPluginInstallationOp,
  listPluginInstallationsOp,
  revokePluginCapabilityOp,
  stagePluginInstallationOp,
} from "./ops/plugins/installations.js";
import { listPluginPendingActionsOp, rejectPluginProposalOp } from "./ops/plugins/pending_queue.js";
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
import { reloadPluginOp } from "./ops/plugins/reload.js";
import { executeUninstallPluginOp, proposeUninstallPluginOp } from "./ops/plugins/uninstall.js";
import {
  getProvisioningOutputsOp,
  setProvisioningOutputsOp,
  verifyDnsRecordOp,
} from "./ops/provisioning_outputs.js";
import { revokeAcceptancesOp } from "./ops/quality/admin.js";
import { planAutoRedeployOp, settleAutoPublishOp } from "./ops/quality/auto-publish.js";
import { classifyStageOp } from "./ops/quality/classify_stage.js";
import {
  ackChatNotificationOp,
  chatStatusOp,
  claimChatNotificationOp,
  gateStatusOp,
  publishAnywayOp,
  releaseChatNotificationOp,
  retryAuditOp,
} from "./ops/quality/gate.js";
import { claimNextAuditOp, enqueueAuditOp } from "./ops/quality/lifecycle.js";
import {
  executeQualityProposalOp,
  listPendingQualityProposalsOp,
  proposeAcceptOp,
  proposePublishAnywayOp,
  rejectQualityProposalOp,
} from "./ops/quality/pending.js";
import { getAuditOp, listAcceptancesOp, listAuditsOp } from "./ops/quality/read.js";
import { recordAuditResultOp } from "./ops/quality/record-result.js";
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
  spendWindowOp,
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
  setTranslationModelOp,
} from "./ops/security/ai_providers.js";
import { auditByRequestIdOp } from "./ops/security/audit_by_request.js";
import {
  mcpExecuteToolOp,
  mcpGetApprovalOutcomeOp,
  mcpGetContextOp,
  mcpListToolsOp,
  mcpOpenSessionOp,
} from "./ops/security/mcp_power.js";
import {
  blockMcpRemoteUserOp,
  listMcpRemoteConnectionsOp,
  restoreMcpRemoteConnectionOp,
  revokeMcpRemoteConnectionOp,
  setMcpRemoteConnectionCapOp,
  unblockMcpRemoteUserOp,
} from "./ops/security/mcp_remote_connections.js";
import {
  createMcpTokenOp,
  listMcpTokensOp,
  mcpAuthorizeUploadOp,
  mcpGetVersionOp,
  mcpSendChatOp,
  revokeMcpTokenOp,
} from "./ops/security/mcp_tokens.js";
import {
  clearOperatorOAuthClientOp,
  getOperatorOAuthClientOp,
  operatorOAuthClientForSyncOp,
  setOperatorOAuthClientOp,
} from "./ops/security/operator_oauth.js";
import { getTelemetryOp, setTelemetryOp, testSendTelemetryOp } from "./ops/security/telemetry.js";
import {
  pagesSeoApplyTranslationOp,
  pagesSeoAutofillOp,
  pagesSeoGetOp,
  pagesSeoListStaleOp,
  pagesSeoOptimizeManyOp,
  pagesSeoOptimizeOp,
  pagesSeoSetOp,
  siteDefaultsGetSeoOp,
  siteDefaultsSeedSiteBaseUrlOp,
  siteDefaultsSetSeoOp,
} from "./ops/seo.js";
import { pagesSeoAutofillManyOp, pagesSeoSetManyOp } from "./ops/seo-bulk.js";
import { getSiteDefaultsOp, setSiteDefaultsOp, setSiteIdentityOp } from "./ops/site_defaults.js";
import {
  executeSiteDefaultsProposalOp,
  listPendingSiteDefaultsProposalsOp,
  proposeSiteSeoSetOp,
  rejectSiteDefaultsProposalOp,
} from "./ops/site_defaults_pending.js";
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
import { stageReadinessOp } from "./ops/stage_readiness.js";
import {
  getStagingAccessOp,
  issueStagingOpenLinkOp,
  provisionStagingOp,
  rotateStagingCredentialsOp,
  seedStagingHostOp,
  setStagingAccessOp,
  setStagingHostOp,
} from "./ops/staging_access.js";
import { stepUpConfirmPasswordOp } from "./ops/step-up.js";
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
import { themeFontDeliveryOp } from "./ops/theme-font-delivery.js";
import {
  duplicateThemeOp,
  exportThemeDtcgOp,
  getActiveThemeOp,
  getThemeOp,
  importThemeOp,
  listThemeHistoryOp,
  listThemesOp,
  setThemeAssetOp,
  updateThemeMetaOp,
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
  listPendingToolApprovalsOp,
  markToolApprovalResultOp,
  queueToolApprovalOp,
  readToolApprovalForExecuteOp,
  rejectToolApprovalOp,
} from "./ops/tool_approvals.js";
import {
  operatorAccessMembersOp,
  operatorAccessRunOp,
  recordOperatorAccessRunOp,
  recordOperatorAccessSyncOp,
} from "./ops/user_access.js";
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
  adminSetPasswordOp,
  changePasswordOp,
  createFirstOwnerOp,
  createUserOp,
  deleteUserOp,
  isSetupCompleteOp,
  listUsersOp,
  setUserEmailOp,
  setUserRolesOp,
} from "./ops/users.js";

export function registerAdminOps(registry: OperationRegistry): void {
  registry.register(importFontOp);
  registry.register(findFontsOp);
  registry.register(inspectFontOp);
  registry.register(resolveFontOp);
  registry.register(readFontOp);
  registry.register(stagePluginInstallationOp);
  registry.register(approvePluginInstallationOp);
  registry.register(getApprovedPluginInstallationOp);
  registry.register(finalizePluginInstallationOp);
  registry.register(revokePluginCapabilityOp);
  registry.register(listPluginInstallationsOp);
  registry.register(createFirstOwnerOp);
  registry.register(isSetupCompleteOp);
  registry.register(insertBootstrapTokenOp);
  registry.register(anyBootstrapTokenIssuedOp);
  // P15 — provisioning outputs + DNS guidance.
  registry.register(setProvisioningOutputsOp);
  registry.register(getProvisioningOutputsOp);
  registry.register(verifyDnsRecordOp);
  // #696 — migration state for the admin's deep health check.
  registry.register(appliedAdminMigrationsOp);
  registry.register(appliedPublicMigrationsOp);
  registry.register(listUsersOp);
  registry.register(createUserOp);
  registry.register(setUserRolesOp);
  registry.register(setUserEmailOp);
  registry.register(deleteUserOp);
  registry.register(changePasswordOp);
  registry.register(adminSetPasswordOp);
  // v0.2.21 — users propose/execute pairs. AI proposes via
  // users.propose_*; Owner approves at /settings/users/pending which
  // calls users.execute_proposal (human-only) → runs the underlying
  // users.{create,set_roles,delete} op. AI never handles credentials: a
  // created user's one-time password is issued later by the approver
  // through a credential handoff (#971).
  registry.register(proposeUserCreateOp);
  registry.register(proposeUserSetRolesOp);
  registry.register(proposeUserDeleteOp);
  registry.register(executeUserProposalOp);
  registry.register(recordOperatorAccessSyncOp);
  registry.register(recordOperatorAccessRunOp);
  registry.register(operatorAccessRunOp);
  registry.register(operatorAccessMembersOp);
  registry.register(rejectUserProposalOp);
  registry.register(listPendingUserProposalsOp);
  registry.register(listCredentialHandoffsOp);
  registry.register(issueCredentialOp);
  registry.register(loginOp);
  registry.register(logoutOp);
  registry.register(resolveSessionOp);
  registry.register(requestPasswordResetOp);
  registry.register(resetPasswordOp);
  registry.register(issueOwnerResetOp);
  registry.register(listRolesOp);
  registry.register(createRoleOp);
  registry.register(deleteRoleOp);
  registry.register(updateRolePermissionsOp);
  // v0.2.22 — roles propose/execute pairs. AI proposes via roles.propose_*;
  // Owner approves at /settings/roles/pending which calls
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
  // delete (orphans them) paths via /settings/templates/pending.
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
  // issue #299 — bulk-first build path (CLAUDE.md §11): one call per page.
  registry.register(buildPageOp);
  // 0184 — explicit homepage designation (site_defaults.home_page_id).
  registry.register(setHomePageOp);
  // 0284 (#802) — the page the static build ships as /404.html.
  registry.register(setNotFoundPageOp);
  registry.register(listPageModuleContentOp);
  registry.register(refreshCurrentPathOp);
  registry.register(movePagesManyOp);
  registry.register(planPageMovesOp);
  registry.register(listSharedContentOp);
  registry.register(resolvePublicUrlsOp);
  registry.register(canonicaliseLinkValuesOp);
  // Epic #724 (rollout F) — reference integrity read (check_links, Publish-live check).
  registry.register(checkReferencesOp);
  registry.register(proposeUrlMigrationOp);
  registry.register(executeUrlMigrationOp);
  registry.register(listUrlMigrationPendingOp);
  registry.register(rejectUrlMigrationOp);
  registry.register(proposeUninstallPluginOp);
  // §11.A — revoking a plugin grant (plugins.execute_proposal applies it).
  registry.register(proposeRevokePluginCapabilityOp);
  registry.register(listPluginCapabilityGrantsOp);
  // Owner queue for plugin proposals that wait (Power-MCP has no in-chat card).
  registry.register(listPluginPendingActionsOp);
  registry.register(rejectPluginProposalOp);
  registry.register(executeUninstallPluginOp);
  registry.register(proposePluginActivationOp);
  registry.register(executePluginActivationOp);
  registry.register(getPageModuleContentOp);
  registry.register(setPageModuleContentOp);
  registry.register(setPageModuleContentManyOp);
  registry.register(patchPageModuleFieldsOp);
  // v0.12.0 — content_instances + placement binding ops.
  registry.register(listContentInstancesOp);
  registry.register(getContentInstanceOp);
  registry.register(createContentInstanceOp);
  registry.register(createContentInstancesManyOp);
  registry.register(setContentInstanceValuesOp);
  registry.register(deleteContentInstanceOp);
  // Bulk `_many` variants via the DRY defineBulkOp factory (CLAUDE.md §11).
  registry.register(setContentInstanceValuesManyOp);
  registry.register(deleteContentInstancesManyOp);
  registry.register(setPlacementContentOp);
  registry.register(forkPlacementContentOp);
  registry.register(duplicatePageOp);
  registry.register(changeTemplateOp);
  registry.register(deletePageOp);
  // v0.2.33 — bulk variants per CLAUDE.md §11.
  registry.register(deletePagesManyOp);
  registry.register(updatePagesManyOp);
  registry.register(renderPagePreviewOp);
  // #553 quality gate (Lighthouse audits after a substantial Stage)
  registry.register(classifyStageOp);
  registry.register(enqueueAuditOp);
  registry.register(claimNextAuditOp);
  registry.register(recordAuditResultOp);
  registry.register(listAuditsOp);
  registry.register(getAuditOp);
  registry.register(listAcceptancesOp);
  registry.register(gateStatusOp);
  registry.register(retryAuditOp);
  registry.register(chatStatusOp);
  registry.register(claimChatNotificationOp);
  registry.register(ackChatNotificationOp);
  registry.register(releaseChatNotificationOp);
  registry.register(publishAnywayOp);
  registry.register(proposeAcceptOp);
  registry.register(proposePublishAnywayOp);
  registry.register(executeQualityProposalOp);
  registry.register(rejectQualityProposalOp);
  registry.register(listPendingQualityProposalsOp);
  registry.register(planAutoRedeployOp);
  registry.register(settleAutoPublishOp);
  registry.register(revokeAcceptancesOp);
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
  // Owner approves at /settings/snapshots/pending which calls
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
  registry.register(pinSkillsIndexOp);
  registry.register(getChatBranchIdOp);
  registry.register(renameChatSessionOp);
  registry.register(archiveChatSessionOp);
  registry.register(discardChatBranchOp);
  registry.register(appendChatMessageOp);
  registry.register(markChatMessageInterruptedOp);
  // issue #628 — cross-instance turn serialization (turn-serializer.ts).
  registry.register(acquireChatTurnLeaseOp);
  registry.register(renewChatTurnLeaseOp);
  registry.register(releaseChatTurnLeaseOp);
  // issues #664 / #665 — running agents per chat + authoritative Stop.
  registry.register(getAgentStopEpochOp);
  registry.register(registerAgentRunOp);
  registry.register(heartbeatAgentRunOp);
  registry.register(finishAgentRunOp);
  registry.register(touchExternalAgentOp);
  registry.register(listAgentRunsOp);
  registry.register(cancelAgentsOp);
  registry.register(allowExternalAgentOp);
  // issue #658 — in-chat approvals a turn paused on, and who resumes it.
  registry.register(recordTurnApprovalsOp);
  registry.register(supersedeTurnApprovalsOp);
  registry.register(claimTurnApprovalsOp);
  registry.register(listTurnApprovalsOp);
  registry.register(decideTurnApprovalOp);
  registry.register(mcpGetChatApprovalStateOp);
  registry.register(setResponseMessagesOp);
  registry.register(cacheToolResultOp);
  registry.register(lookupToolResultOp);
  registry.register(recordAiCallOp);
  registry.register(publishChatSessionOp);
  registry.register(mergeChatToMainOp);
  registry.register(finalizeStageOp);
  // issue #262 — pre-run foreign-lock visibility for the chat runner.
  registry.register(listForeignLocksOp);
  // issue #620 — Open changes overview + lock-takeover notices.
  registry.register(listOpenChangesOp);
  registry.register(drainTakeoverNoticesOp);
  // issue #620 Part A/B — the shared draft: selective Stage, undo per chat,
  // isolation for experiments and migrations.
  registry.register(mergeDraftToMainOp);
  registry.register(finalizeDraftStageOp);
  registry.register(undoChatChangesOp);
  registry.register(isolateSessionOp);
  registry.register(checkBranchAccessOp);
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
  registry.register(setTranslationModelOp);
  registry.register(clearAiProviderKeyOp);
  registry.register(anyAiProviderConfiguredOp);
  // v0.2.26 — ai_providers propose/execute pairs (set / clear_key).
  // AI proposes config + isActive; Owner pastes the apiKey inline at
  // approve time at /settings/ai/pending. Reuses the secret-at-approve
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
  // Lightweight windowed spend total for the AppShell top-bar readout.
  registry.register(spendWindowOp);
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
  // #914 — the install's Google sign-in client (ID only; the secret lives in
  // Secret Manager): IAP browser login, IAP programmatic access and the
  // remote-MCP broker. Read by the setup pages and the operator-access sync job.
  registry.register(getOperatorOAuthClientOp);
  registry.register(setOperatorOAuthClientOp);
  registry.register(clearOperatorOAuthClientOp);
  registry.register(operatorOAuthClientForSyncOp);
  registry.register(mcpSendChatOp);
  registry.register(mcpAuthorizeUploadOp);
  registry.register(mcpGetVersionOp);
  // Issue #376 — Power-MCP: admin-scoped tokens drive the chat-runner
  // tool catalogue directly (external agent owns the loop). See
  // ops/security/mcp_power.ts for the invariants.
  registry.register(mcpListToolsOp);
  registry.register(mcpOpenSessionOp);
  registry.register(mcpExecuteToolOp);
  registry.register(mcpGetContextOp);
  // Issue #658 — hand an operator's decision on an MCP-queued proposal
  // back to the external agent (read-only for the agent).
  registry.register(mcpGetApprovalOutcomeOp);
  registry.register(listMcpApprovalHandoffsOp);
  // Issue #806 — remote MCP connections (IAP identity, no bearer): the
  // Owner's list / revoke / restore / cap controls.
  registry.register(listMcpRemoteConnectionsOp);
  registry.register(revokeMcpRemoteConnectionOp);
  registry.register(restoreMcpRemoteConnectionOp);
  registry.register(blockMcpRemoteUserOp);
  registry.register(unblockMcpRemoteUserOp);
  registry.register(setMcpRemoteConnectionCapOp);
  // v0.2.27 — mcp_tokens propose/execute pairs (create / revoke).
  // AI proposes new tokens by displayName + cap; the Owner approves and
  // collects the token from a credential handoff (#971), like the new
  // user's password from users.execute_proposal.
  registry.register(proposeMcpTokenCreateOp);
  registry.register(proposeMcpTokenRevokeOp);
  registry.register(executeMcpTokenProposalOp);
  registry.register(rejectMcpTokenProposalOp);
  registry.register(listPendingMcpTokenProposalsOp);
  // P6 deploy
  registry.register(listDeployTargetsOp);
  registry.register(listDeployRunsOp);
  registry.register(stageReadinessOp);
  registry.register(triggerDeployOp);
  registry.register(promoteDeployOp);
  registry.register(rollbackDeployOp);
  registry.register(updateDeployProgressOp);
  // #1003 — a run's row, committed when it starts (visible while it runs).
  registry.register(beginDeployRunOp);
  // #969 — the orchestrator's keep-alive for the served staging preview.
  registry.register(refreshStagingPreviewOp);
  // v0.2.19 — propose/execute pair for promote + rollback. AI proposes
  // (human + ai + system); Owner approves at /settings/deployments/pending
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
  // Epic #724 rollout E — literal links → references, report, revert.
  registry.register(migrateLinksToReferencesOp);
  registry.register(getLinkMigrationReportOp);
  registry.register(revertLinkMigrationOp);
  registry.register(getStructuredSetOp);
  registry.register(listStructuredSetsOp);
  registry.register(deleteStructuredSetOp);
  // v0.11.0 — themes primitive (#45). Routine read + write ops plus
  // the §11.A propose/execute gate for create / activate / delete.
  registry.register(listThemesOp);
  registry.register(getThemeOp);
  registry.register(getActiveThemeOp);
  registry.register(updateThemeTokensOp);
  registry.register(themeFontDeliveryOp);
  // v0.11.4 (issue #76 follow-up) — meta editor + history reader.
  registry.register(updateThemeMetaOp);
  registry.register(listThemeHistoryOp);
  registry.register(setThemeAssetOp);
  registry.register(duplicateThemeOp);
  registry.register(importThemeOp);
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
  // layouts.propose_*; Owner approves at /settings/layouts/pending
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
  // v0.11.4 (issue #76 follow-up) — site identity onboarding writer.
  registry.register(setSiteIdentityOp);
  // issue #163 — Site Genesis draft storage.
  registry.register(addGenesisDraftOp);
  registry.register(listGenesisDraftsOp);
  registry.register(selectGenesisDraftOp);
  // issue #375 — view-time theme-shell composition for draft previews.
  registry.register(renderDesignDraftOp);
  // issue #264 — per-page edit log (durable work history for later chats /
  // subagents that touch the page). Append-only, ungated.
  registry.register(appendPageLogOp);
  registry.register(listPageLogOp);
  registry.register(logModuleizeAttemptOp);
  // 2026-07 — AI-filed bug reports (info source + per-run metric).
  registry.register(createBugReportOp);
  // Epic #901 — forwarding bug reports to the Caelo team (opt-in).
  registry.register(getBugForwardingOp);
  registry.register(setBugForwardingOp);
  registry.register(queueUnsentBugReportsOp);
  registry.register(previewBugForwardingOp);
  registry.register(claimDueBugReportsOp);
  registry.register(recordBugForwardResultOp);
  registry.register(bugForwardingIdentityOp);
  registry.register(markBugIntakeRegisteredOp);
  registry.register(bugClustersToRefreshOp);
  registry.register(recordBugClusterStatusOp);
  registry.register(listBugReportsOp);
  // P12 review pass — email transport singleton.
  registry.register(getEmailConfigOp);
  registry.register(setEmailConfigOp);
  registry.register(sendTestEmailOp);
  // v0.2.25 — email_config propose/execute pair. AI proposes
  // transport+fromAddress+config-without-secrets; Owner supplies the
  // smtp password / resend apiKey / SES key inline at approve time
  // via /settings/email/pending. Introduces the secret-at-approve
  // pattern that ai_providers and mcp_tokens reuse later.
  registry.register(proposeEmailConfigSetOp);
  registry.register(executeEmailConfigProposalOp);
  registry.register(rejectEmailConfigProposalOp);
  registry.register(listPendingEmailConfigProposalsOp);
  // §11.A gate for AI budgets / AI pricing / gateway settings — the AI
  // proposes, the operator approves (owner_settings_pending.ts).
  registry.register(proposeSetAiBudgetOp);
  registry.register(proposeSetAiPricingOp);
  registry.register(proposeSetGatewaySettingsOp);
  registry.register(proposeSetTranslationModelOp);
  registry.register(proposeSetPluginAiCostCapOp);
  registry.register(proposeRotateGatewayCookieSecretOp);
  registry.register(proposeSetStagingAccessOp);
  registry.register(proposeRotateStagingCredentialsOp);
  registry.register(proposeSetStagingHostOp);
  registry.register(executeOwnerSettingsProposalOp);
  registry.register(rejectOwnerSettingsProposalOp);
  registry.register(listPendingOwnerSettingsProposalsOp);
  // P14 — domains registry.
  registry.register(listDomainsOp);
  registry.register(addDomainOp);
  registry.register(removeDomainOp);
  registry.register(verifyDomainOp);
  registry.register(setDomainTlsStatusOp);
  // v0.2.30 — domains propose/execute pairs (add / remove). AI
  // proposes via domains.propose_*; Owner approves at
  // /settings/domains/pending. domains.verify is widened to AI in the
  // same release (diagnostic, no destructive side effect).
  registry.register(proposeDomainAddOp);
  registry.register(proposeDomainRemoveOp);
  // Firebase Hosting custom domains (gcp-firebase): live status + stuck
  // detection (AI-readable), reconnect gated through propose_reconnect.
  registry.register(hostingStatusOp);
  registry.register(reconnectHostingDomainOp);
  registry.register(proposeDomainReconnectOp);
  registry.register(executeDomainProposalOp);
  registry.register(rejectDomainProposalOp);
  registry.register(listPendingDomainProposalsOp);
  // P14 — Site Import Wizard.
  registry.register(listImportRunsOp);
  registry.register(getImportRunOp);
  // issue #422 — lean per-run page list (ids + status, no HTML payload);
  // the AI-facing surface behind list_import_pages.
  registry.register(listImportPagesOp);
  registry.register(createImportRunOp);
  registry.register(proposeImportRunOp);
  registry.register(listPendingImportProposalsOp);
  // issue #198 — per-page screenshot keys (serve route + AI tool).
  registry.register(getImportPageScreenshotKeysOp);
  registry.register(getImportPageGistOp);
  // issue #197 — rebuild notes + run report.
  registry.register(addImportPageNotesOp);
  registry.register(getImportRunReportOp);
  // issue #280 — migration cost gate: operator-confirmed budget + live spend.
  registry.register(setCostCeilingOp);
  registry.register(getRunCostOp);
  // issue #297 — auto-armed ceiling: live per-loop gate state + one-shot
  // warn/trip claims.
  registry.register(getSessionBudgetStateOp);
  registry.register(recordBudgetGateEventOp);
  // issue #298 — estimator learning loop: observed vs estimated per run.
  registry.register(getRunCalibrationOp);
  // issue #248 (WS2) — rebuild-quality checks: content-inventory
  // (no information loss) + repeated-subtree boilerplate detection.
  registry.register(checkImportPageInventoryOp);
  registry.register(detectImportBoilerplateOp);
  registry.register(executeImportProposalOp);
  registry.register(rejectImportProposalOp);
  registry.register(updateImportRunStatusOp);
  registry.register(updatePageCaptureOp);
  // issue #423 — crawl-time bulk capture persistence (screenshot keys +
  // sampled tokens per batch, keyed by run_id + source_url).
  registry.register(setPageCapturesByUrlOp);
  // issue #28 — run-scoped error/warning ledger.
  registry.register(logImportRunEventOp);
  registry.register(logImportRunEventsOp);
  // issue #247 — run-level computed-style token aggregate.
  registry.register(setRunDesignTokensOp);
  registry.register(writeExtractedPagesOp);
  registry.register(acceptImportedPageOp);
  registry.register(acceptImportedPagesOp);
  registry.register(cleanupImportRunOp);
  // Epic #724 — turn an import run's links to planned pages into references.
  registry.register(resolveImportLinksOp);
  // Explicit, URL-driven media import (replaces the scan-and-download
  // migrate_media). The AI names the exact source asset URLs to import.
  registry.register(importMediaUrlsOp);
  // Complete, searchable asset inventory of a crawled run's stored HTML —
  // the full list behind inspect_external_page's top-20 `images` glance.
  registry.register(listPageAssetsOp);
  // Issue #650 — the staging.<domain> access gate.
  registry.register(getStagingAccessOp);
  registry.register(setStagingAccessOp);
  registry.register(rotateStagingCredentialsOp);
  registry.register(issueStagingOpenLinkOp);
  registry.register(seedStagingHostOp);
  registry.register(setStagingHostOp);
  registry.register(provisionStagingOp);
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
  // P6.6b — UX polish surface.
  registry.register(aggregateNotificationsOp);
  // #696 — installed vs newest release (Settings → Updates, get_caelo_version).
  registry.register(platformUpdateStatusOp);
  // "Check now" on Settings → Updates (human-only; the fetch runs outside).
  registry.register(platformUpdatesCheckNowOp);
  // #696 Phase 2 — "Install update": Owner + password confirmation (step-up);
  // the upgrader job does the install. list/get/policy.get are AI-readable.
  registry.register(platformUpdatesRequestOp);
  registry.register(platformUpdatesCancelOp);
  registry.register(platformUpdatesContinueOp);
  registry.register(platformUpdatesRecordTriggerOp);
  registry.register(platformUpdatesListOp);
  registry.register(platformUpdatesGetOp);
  registry.register(platformUpdatesSupersedeStaleOp);
  registry.register(platformUpdatesAgentStatusOp);
  registry.register(platformUpdatePolicyGetOp);
  registry.register(platformUpdatePolicySetOp);
  // #696 Phase 5 — automatic updates: Owner pause/resume (step-up), the
  // admin's scheduler (system) and its status (AI-readable).
  registry.register(platformUpdatePolicyPauseOp);
  registry.register(platformUpdatePolicyResumeOp);
  registry.register(platformUpdatesSchedulerTickOp);
  registry.register(platformUpdatesNotificationClaimOp);
  registry.register(platformUpdatesNotificationFinishOp);
  registry.register(platformUpdatesSchedulerStatusOp);
  // #868 — "Skip this time" for a scheduled automatic install (Owner, step-up).
  registry.register(platformUpdatesSkipScheduledOp);
  // #757 — the step-up for the actions above: the Owner's password, re-entered.
  registry.register(stepUpConfirmPasswordOp);
  // v0.2.32 — cross-domain pending proposals aggregator. Used by the
  // chat-runner's `## Pending proposals` system-prompt block (so the
  // AI doesn't re-propose what's already queued) and by the AppShell
  // bell badge (cross-domain count of "things waiting on you").
  registry.register(listPendingProposalsAcrossDomainsOp);
  // v0.2.37 — cancel a pending proposal the AI queued in error
  // (or the human Owner did). Restricted to the actor who proposed it
  // by the WHERE clause; doesn't grant cross-actor cancel rights.
  registry.register(cancelProposalOp);
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
  registry.register(mediaSetSourceOp);
  registry.register(mediaSetVisibilityOp);
  // Bulk `_many` variants via the DRY defineBulkOp factory (CLAUDE.md §11).
  registry.register(mediaUpdateAltManyOp);
  registry.register(mediaSetSourceManyOp);
  registry.register(mediaSetVisibilityManyOp);
  registry.register(imageRequestsReadOp);
  registry.register(imageRequestsReserveOp);
  registry.register(imageRequestsFinishOp);
  registry.register(imageRequestsMarkUncertainOp);
  registry.register(mediaDeleteOp);
  registry.register(mediaDeleteManyOp);
  registry.register(mediaRecordUsageOp);
  registry.register(mediaListUsagesOp);
  registry.register(mediaGetSettingsOp);
  registry.register(setMediaCdnOp);
  // run #10 D4 — recovery path for missing derived variants.
  registry.register(regenerateMediaVariantsOp);
  registry.register(ensureActiveFaviconRenditionOp);
  registry.register(mediaListMissingFilesOp);
  // P7 optimizations — focal-point/crops, processing status, alt proposals.
  registry.register(setFocalPointOp);
  registry.register(addCropOp);
  registry.register(deleteCropOp);
  registry.register(listCropsOp);
  registry.register(getProcessingStatusOp);
  registry.register(proposeAltOp);
  registry.register(listAltProposalsOp);
  registry.register(reviewAltProposalOp);
  // P8 — SEO sidecar + site SEO defaults.
  registry.register(pagesSeoGetOp);
  registry.register(pagesSeoSetOp);
  // Bulk `_many` variant via the DRY defineBulkOp factory (CLAUDE.md §11).
  registry.register(pagesSeoSetManyOp);
  registry.register(pagesSeoAutofillOp);
  registry.register(pagesSeoAutofillManyOp);
  registry.register(pagesSeoApplyTranslationOp);
  registry.register(pagesSeoOptimizeOp);
  registry.register(pagesSeoOptimizeManyOp);
  registry.register(pagesSeoListStaleOp);
  registry.register(siteDefaultsGetSeoOp);
  registry.register(siteDefaultsSeedSiteBaseUrlOp);
  registry.register(siteDefaultsSetSeoOp);
  // §11.A gate in front of set_seo: the AI proposes (propose_set_site_seo),
  // the Owner approves in the chat or on Settings → SEO.
  registry.register(proposeSiteSeoSetOp);
  registry.register(executeSiteDefaultsProposalOp);
  registry.register(rejectSiteDefaultsProposalOp);
  registry.register(listPendingSiteDefaultsProposalsOp);
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
  registry.register(reloadPluginOp);
  // v0.2.18 — comments long-term archive (cms_public is now ephemeral
  // after moderation; long-term store + static-render reads land here).
  registry.register(commentArchiveInsertOp);
  registry.register(commentArchiveListForPageOp);
}
