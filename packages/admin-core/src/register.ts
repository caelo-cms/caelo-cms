// SPDX-License-Identifier: MPL-2.0

import type { OperationRegistry } from "@caelo/query-api";
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
import {
  listDeployRunsOp,
  listDeployTargetsOp,
  promoteDeployOp,
  rollbackDeployOp,
  triggerDeployOp,
  updateDeployProgressOp,
} from "./ops/deploy.js";
import {
  mediaDeleteOp,
  mediaGetOp,
  mediaGetSettingsOp,
  mediaListOp,
  mediaListUsagesOp,
  mediaRecentForAiOp,
  mediaRecordUsageOp,
  mediaUpdateAltOp,
  mediaUploadOp,
  setMediaCdnOp,
} from "./ops/media.js";
import { aggregateNotificationsOp } from "./ops/notifications.js";
import {
  createRedirectOp,
  deleteRedirectOp,
  listRedirectsOp,
  lookupRedirectOp,
} from "./ops/redirects.js";
import { createRoleOp, deleteRoleOp, listRolesOp, updateRolePermissionsOp } from "./ops/roles.js";
import { aggregateAiCallsOp } from "./ops/security/ai_calls.js";
import {
  listAiMemoryOp,
  listMemoryProposalsOp,
  proposeAiMemoryOp,
  reviewAiMemoryOp,
  setAiMemoryOp,
} from "./ops/security/ai_memory.js";
import { listAiProvidersOp, setAiProvidersOp } from "./ops/security/ai_providers.js";
import { getSiteDefaultsOp, setSiteDefaultsOp } from "./ops/site_defaults.js";
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
  registry.register(aggregateAiCallsOp);
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
  registry.register(mediaRecordUsageOp);
  registry.register(mediaRecentForAiOp);
  registry.register(mediaListUsagesOp);
  registry.register(mediaGetSettingsOp);
  registry.register(setMediaCdnOp);
}
