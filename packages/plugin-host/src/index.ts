// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host — P11.5 Tier-1 plugin runtime.
 *
 * Bootstrap walks `packages/plugins/<slug>/`, verifies signatures, runs the
 * validator, and registers each Tier-1 plugin's tools + workers + prompt-
 * context renderers + actor row. Operations dispatch via runPluginOperation;
 * background workers tick on schedule. Tier 2 plugins go through the existing
 * P11 lifecycle (submit → activate → cms_public schema provisioned).
 */

export { externalArtifactDigest } from "@caelo-cms/plugin-sandbox";
export type { ContentVariantPage, ContentVariantPlacement } from "@caelo-cms/plugin-sdk";
export { pluginManifest } from "@caelo-cms/plugin-sdk";
export {
  type AuditPageFactsReader,
  auditFindingContributors,
  collectPluginAuditFindings,
} from "./audit-findings.js";
export { type BakedDataPlugin, bakedDataPlugin, bakedDataVisitorTrigger } from "./baked-data.js";
export { bakedDataPageIds, MAX_BAKED_PAGES_PER_CALL } from "./baked-data-pages.js";
export {
  BUILD_PLUGIN_METHODS,
  type BuildPluginMethod,
  type BuildPluginServices,
  decodeBuildPayload,
  encodeBuildPayload,
  isBuildPluginMethod,
  localBuildPluginServices,
  remoteBuildPluginServices,
  type StaticRenderPlugin,
  serveBuildPluginCall,
} from "./build-services.js";
export { makePluginContext } from "./capabilities.js";
export {
  collectBuildAssets,
  injectPluginAssets,
  PLUGIN_ASSET_DIR,
  type PluginClientAsset,
} from "./client-assets.js";
export {
  consentPurposeDeclared,
  declaredConsentPurposes,
  pluginDeclaresConsentPurpose,
} from "./consent-purposes.js";
export {
  contentVariantProblemMarker,
  hasContentVariantContributors,
  type ResolvedContentVariant,
  type ResolvedContentVariants,
  resolveContentVariants,
} from "./content-variants.js";
export {
  type ResolvedDeferral,
  type ResolvedDeferrals,
  resolveModuleDeferrals,
} from "./deferrals.js";
export {
  type DevKeyPair,
  type DevSignReport,
  ensureDevSignedManifests,
  loadOrCreateDevKey,
  TRUST_ROOT_FILENAME,
} from "./dev-signing.js";
export {
  assertInvocationConsistent,
  type EmailTransport,
  hostInfra,
  hostSystemActorId,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  MAIN_RENDER,
  type PluginHostInfra,
  pluginToolSurfaceGeneration,
  type RenderScope,
  type RunPluginOperationOpts,
  type RunPluginOperationResult,
  renderInvocation,
  resetDisabledSet,
  runPluginBuildAssets,
  runPluginMetaSignature,
  runPluginMetaSignatureBatch,
  runPluginOperation,
  runPluginStaticRender,
  type SnapshotEmitter,
  type SnapshotEmitterInput,
  setPluginDisabled,
  toolArgsProblem,
  type VisitorDispatchContext,
} from "./dispatch.js";
export { operatorHasPermission } from "./external-authorization.js";
export { resolvePreviewFonts } from "./font-preview.js";
export {
  bootstrapDispatchOnly,
  type DispatchOnlyBootstrapOpts,
  resetDispatchOnlyHost,
  SYNC_TTL_MS,
  syncDispatchPlugins,
} from "./gateway-attach.js";
export {
  commentArchiveListForPageOp,
  registerGatewayOperations,
} from "./gateway-ops.js";
export {
  type CollectedContributions,
  collectContributions,
  composeHeadBlock,
  renderHeadEntries,
} from "./head-composition.js";
export {
  finishImageRequest,
  type ImageRequestRecord,
  markImageRequestUncertain,
  readImageRequest,
  reserveImageRequest,
} from "./image-ledger.js";
export {
  applyPluginLifecycle,
  deregisterPlugin,
  type PluginLifecycleAction,
} from "./lifecycle.js";
export {
  collectPluginLinkLocations,
  type PluginLinkLocationSet,
  pluginAdminSchemaName,
  readMainPluginRow,
  writeMainPluginColumn,
} from "./link-locations.js";
export {
  hasLinkResolveContributors,
  type ResolvedLinkVariants,
  resolveLinkVariants,
} from "./link-resolve.js";
export { type ActiveListExt, activeListExt, compileListExt } from "./list-ext.js";
export {
  hasListResolveContributors,
  LIST_RESOLVE_ANSWER_MAX_BYTES,
  mergeListOverlays,
  overlayIssueOwner,
  type PluginListOverlays,
  type ResolvedListOverlays,
  reportListOverlayIssues,
  resolveListOverlays,
} from "./list-resolve.js";
export {
  checkListSourceEntries,
  dormantListSourceNames,
  LIST_SOURCE_ANSWER_MAX_BYTES,
  type ResolvedListSources,
  resolveListSources,
} from "./list-source-resolution.js";
export { pluginListSourcesRegistry } from "./list-sources.js";
export {
  activateApprovedExternalPlugin,
  type BootstrapOpts,
  bootstrap,
  type LoadReport,
  loadActivatedPlugin,
  resetPluginHost,
} from "./loader.js";
// #1008 — whether a plugin runs in this process: where its skills are
// available, and what the Publish-live gate checks every active plugin against.
export {
  pluginFailedHereReason,
  pluginRunsHere,
} from "./local-availability.js";
// #1214 — module changes reach the plugins that keep a per-module verdict.
export {
  type ModuleChangeScope,
  moduleChangeContributors,
  moduleChangeInvocation,
  notifyModuleChanges,
} from "./module-changes.js";
export {
  activeDependentsOf,
  dependentsMessage,
  type InactiveRequirement,
  inactiveRequiredPlugins,
  requiredPluginsOf,
  requirementsMessage,
} from "./plugin-dependencies.js";
export type { PluginRowLocker } from "./private-storage.js";
export {
  type PromptContextRenderer,
  pluginPromptContextRegistry,
} from "./prompt-context-registry.js";
export {
  type PublicUrlContext,
  type PublicUrlPage,
  resolvePublicPageUrls,
} from "./public-urls.js";
export {
  type PluginNotRunning,
  pluginNotRunningMarker,
  pluginNotRunningReason,
  pluginNotRunningSlug,
  pluginsNotRunningHere,
  reconcilePluginHostNow,
  resetPluginHostSync,
  syncPluginHost,
} from "./reconcile.js";
export {
  createPluginRenderFailureSink,
  type PluginRenderFailure,
  pluginRenderFailedMarker,
  pluginRenderFailedSlug,
  reportPluginRenderFailure,
} from "./render-failures.js";
export {
  applyPluginRowState,
  discardBranchPluginRows,
  insertPluginRowSnapshot,
  loadBranchRowStates,
  type PluginRowRef,
  type PluginRowState,
  withPluginScope,
} from "./row-snapshots.js";
export { stopRuntimeHeartbeat } from "./runtime-health.js";
export {
  pluginWorkerScheduler,
  type ScheduledWorker,
} from "./scheduler.js";
export { recordExternalToolApproval } from "./tool-approval-binding.js";
export {
  pluginToolsRegistry,
  type RegisteredPluginTool,
} from "./tools-registry.js";
export type { AICompletion, AIMessage, AIObjectCompletion, AIProvider } from "./types.js";
export {
  collectUrlAnnotations,
  type DecodedPagePath,
  decodePagePath,
  type RegisteredUrlContribution,
  type ResolvedPageUrl,
  resolvePageUrl,
  type UrlCompositionView,
  urlContributionsRegistry,
} from "./url-composition.js";
export {
  resolveVisitorConsentRule,
  VISITOR_ID_PURPOSE,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "./visitor-consent.js";
export {
  collectPluginWriteHints,
  type PluginWriteHintsResult,
  writeHintContributors,
} from "./write-hints.js";
