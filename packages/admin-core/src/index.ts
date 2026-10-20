// SPDX-License-Identifier: MPL-2.0

// issue #150 — theme web-font resolver. Canonical implementation lives
// in the static-generator (admin-core already depends on that app for
// deploy publishing; hosting it here would close a module cycle).
export {
  clearFontResolverMemo,
  defaultFontsCacheDir,
  type ResolvedThemeFonts,
  type ResolveThemeFontsArgs,
  resolveThemeFonts,
} from "@caelo-cms/static-generator";
export * from "./ai/chat-runner.js";
// issue #298 — the calls×context import cost model + calibration helpers.
export * from "./ai/import-cost-model.js";
export * from "./ai/model-catalog.js";
export { makePluginImageProvider } from "./ai/plugin-image-provider.js";
export { transformPluginImage } from "./ai/plugin-image-transform.js";
export { makePluginTextProvider } from "./ai/plugin-text-provider.js";
// issue #412 — server-side screenshot_page backend: in-process capture
// service + the signed branch-scoped tokens its browser presents (the
// admin's preview-screenshot + asset routes verify them).
export {
  capturePreviewScreenshot,
  type PreviewScreenshotResult,
  type PreviewScreenshotViewport,
  resolvePreviewSelfOrigin,
} from "./ai/preview-screenshot.js";
export {
  mintPreviewScreenshotToken,
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
  type PreviewScreenshotTokenVerification,
  verifyPreviewScreenshotToken,
} from "./ai/preview-screenshot-token.js";
export * from "./ai/pricing-cache.js";
export * from "./ai/provider.js";
export {
  checkProviderKeyHealth,
  configureProviderResolver,
  getActiveProvider,
  getProviderByName,
  invalidateProviderCache,
  knownProviderNames,
  type ProviderKeyHealth,
} from "./ai/provider-resolver.js";
export * from "./ai/providers/index.js";
export {
  type ApprovedToolCallResult,
  approveQueuedToolCall,
} from "./ai/queued-tool-approval.js";
export {
  awaitScreenshot,
  clearPendingScreenshots,
  deliverScreenshot,
  failScreenshot,
} from "./ai/screenshot-orchestrator.js";
export * from "./ai/system-prompt.js";
// v0.2.77 — describeError reused by SvelteKit form actions to surface
// the underlying QueryError reason (e.g. "Staging build failed: ...").
export { describeError } from "./ai/tools/_describe-error.js";
export * from "./ai/tools/index.js";
export * from "./audit.js";
// v0.2.37 — proposal GC sidecar (sweeps stale pending rows daily).
export {
  startChatImageGcWorker,
  stopChatImageGcWorker,
  sweepChatImagesOnce,
} from "./chat-image-gc-worker.js";
export * from "./csrf.js";
// #842 — reading a staged GCS run (admin staging preview).
export {
  readStagedBuildFiles,
  readStagedObject,
  StagedRunError,
} from "./deploy/staged-build-files.js";
// #650 — which installs serve staging at a protected staging.<domain>.
export { providerHasStagingDomain } from "./deploy/staging-domain.js";
// #724 — the Stage warning for links to pages a build does not contain.
export {
  describeUnpublishedLinks,
  type UnpublishedLinkTarget,
} from "./deploy/unpublished-links.js";
// P11.5 audit fix #3 — exposed for plugin-host's PluginHostInfra DI.
export {
  _domainEventGcOnceForTests,
  startDomainEventGcWorker,
  stopDomainEventGcWorker,
} from "./domain-event-gc-worker.js";
export { type DomainEventInput, type DomainEventKind, emitDomainEvent } from "./domain-events.js";
export {
  type DeliverResetEmailArgs,
  deliverPasswordResetEmail,
  passwordResetEmailProblem,
  type ResetEmailContext,
} from "./email/password-reset.js";
// P12 review pass — email transport factory (consumed by hooks.server.ts).
export {
  buildEmailTransport,
  type EmailConfigRow,
  emailDeliveryProblem,
} from "./email/transport.js";
export { lockPluginRow } from "./locks.js";
export { assertDurableMediaRoot, type MediaStorageSetup } from "./media/durable-root.js";
export * from "./media/pipeline.js";
export { resolvePrivatePreviewImages } from "./media/private-preview-images.js";
export { sanitizeSvg } from "./media/sanitize-svg.js";
export * from "./media/storage.js";
// #589 — approver permissions declared on the §11.A executor ops.
export { approverPermissionsOf } from "./ops/_approver-permission.js";
export * from "./ops/auth.js";
export * from "./ops/deploy.js";
// issue #297 — pure cost-gate math for the approve UI (shows the ceiling a
// click will arm; requires a budget input when the estimate failed).
export {
  deriveCeilingFromEstimate,
  ESTIMATE_CEILING_SAFETY_FACTOR,
  formatMicrocentsAsMoney,
  microcentsToMajorUnits,
} from "./ops/imports-cost.js";
export {
  type PlatformUpdateEvent,
  type PlatformUpdateRequest,
  startUpgraderFor,
} from "./ops/platform-update-requests.js";
export type {
  SchedulerStatus,
  UpdateNotification,
} from "./ops/platform-update-scheduler.js";
// #696 — installed vs newest release; Settings → Updates reads it.
export { type PlatformUpdateStatus, UPDATES_PATH } from "./ops/platform-updates.js";
export {
  configurePluginUninstallFinalizer,
  type PluginUninstallFinalizer,
} from "./ops/plugins/uninstall.js";
export * from "./ops/roles.js";
// Issue #806 — remote MCP: the credential an /api/mcp/remote/* request
// carries into the mcp.* ops, and its request-time resolution.
export {
  type McpRemoteCredential,
  type McpRemoteSurface,
  mcpRemoteSurface,
} from "./ops/security/mcp_credential.js";
export {
  type McpPrincipal,
  type RemoteMcpRefusal,
  resolveRemoteMcpPrincipal,
} from "./ops/security/mcp_principal.js";
export type { McpRemoteConnectionRow } from "./ops/security/mcp_remote_connections.js";
// P17 PR4 — MCP bridge wiring helper.
export { configureMcpBridge } from "./ops/security/mcp_tokens.js";
export { STEP_UP_SIGNED_OUT } from "./ops/step-up.js";
// Operator access (Google IAP) follows user changes made in the panel too.
export {
  describeOperatorAccessSync,
  latestOperatorAccessRun,
  type OperatorAccessSync,
  syncOperatorAccess,
} from "./ops/user_access.js";
export * from "./ops/users.js";
export * from "./password.js";
export * from "./permissions.js";
// P21 ship 5 — release-check sidecar worker (replaces the in-handler
// GitHub fetch; bootstrap from hooks.server.ts).
// #696 Phase 5 — the auto-update scheduler (bootstrapped from hooks.server.ts).
export {
  type CheckReleasesNowResult,
  checkReleasesNow,
  RELEASE_CHECK_COOLDOWN_MS,
  type ReleaseFetch,
} from "./platform-updates/release-check.js";
export {
  type ManifestReader,
  readReleaseFacts,
  registryManifestReader,
} from "./platform-updates/release-facts.js";
export {
  runAutoUpdateTick,
  startAutoUpdateScheduler,
  stopAutoUpdateScheduler,
  type UpgraderResolver,
} from "./platform-updates/scheduler.js";
// #819 — which job installs a release (upgrader or converge job).
export {
  chooseUpdateRoute,
  type LastUpdateAttempt,
  type UpdateRoute,
  type UpdateRouteInput,
} from "./platform-updates/update-route.js";
export { startProposalGcWorker, stopProposalGcWorker } from "./proposal-gc-worker.js";
export * from "./public-projection.js";
// #553 — quality-audit worker (Lighthouse after a substantial Stage).
export { kickQualityAuditWorker, startQualityAuditWorker } from "./quality/audit-worker.js";
export * from "./rate-limit.js";
export * from "./register.js";
export { startReleaseCheckWorker, stopReleaseCheckWorker } from "./release-check-worker.js";
export {
  createIapVerifier,
  IAP_ASSERTION_HEADER,
  type IapKeyProvider,
  type IapVerifier,
  setIapVerifierForTests,
} from "./security/iap-assertion.js";
export {
  iapTestKeyPair as iapTestKeyPairForTests,
  signIapTestAssertion as signIapTestAssertionForTests,
} from "./security/iap-assertion.test-helpers.js";
// P12+ at-rest secret encryption (project KEK + AES-GCM).
export {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
  generateKekHex,
  kekFingerprint,
} from "./security/secret-box.js";
export {
  STEP_UP_REQUIRED,
  sessionHashOf,
} from "./security/step-up/gate.js";
// #696 Phase 4c — self-hosted installs: the update agent on the server.
export {
  agentInstallCommand,
  agentUnavailable,
  agentUpgraderTrigger,
} from "./security/upgrader/agent-trigger.js";
export {
  CONVERGE_SETUP_HINT,
  type ConvergeJobEnv,
  convergeTriggerFromEnv,
  UPGRADER_SETUP_HINT,
  type UpgraderExecution,
  type UpgraderTrigger,
  UpgraderTriggerError,
  upgraderTriggerFromEnv,
} from "./security/upgrader/job-trigger.js";
export { emitSnapshot } from "./snapshots/emit.js";
// issue #620 — the advisory lock that orders AI merges against automatic
// production publishes (the serialization regression tests take it).
export { AI_STAGE_LOCK_KEY } from "./stage/ai-stage-hold.js";
// issue #620 — the Stage flow for one chat or a selection of chats (/edit's
// Stage button, the Open changes overview).
export {
  enqueueStagingAudit,
  type StagedChats,
  type StageFailure,
  stageChatSessions,
} from "./stage/stage-chats.js";
export * from "./tokens.js";
export * from "./untrusted/public-data.js";
