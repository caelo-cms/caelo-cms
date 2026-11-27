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

export { externalArtifactDigest, releaseManifestDigest } from "@caelo-cms/plugin-sandbox";
export type { ContentVariantPage, ContentVariantPlacement } from "@caelo-cms/plugin-sdk";
// Epic #1644 — the key of one placement (module and content instance), for the generator.
export { canonicalSitePath, placementKey, pluginManifest } from "@caelo-cms/plugin-sdk";
export { resolveAgentFiles, type SiteAgentFiles } from "./agent-files.js";
// #1653 — the one AI spend ledger (text and images).
export {
  AI_LEDGER_LOCK,
  type AiCapRefusal,
  type AiReservation,
  type AiSessionKey,
  type AiSettlement,
  type AiSpender,
  bindingPluginCap,
  checkAiCaps,
  describeAiCapRefusal,
  extendAiSpend,
  type PluginAiCap,
  readPluginAiCap,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "./ai-ledger.js";
export { failureProvedUnbilled } from "./ai-unbilled.js";
export {
  auditFindingContributors,
  type PluginAuditFindings,
  pluginAuditFindingsCall,
} from "./audit-findings.js";
export { type BakedDataPlugin, bakedDataPlugin, bakedDataVisitorTrigger } from "./baked-data.js";
export { bakedDataPageIds, MAX_BAKED_PAGES_PER_CALL } from "./baked-data-pages.js";
export {
  branchOverlayJournalFilter,
  branchOverlayReadCount,
  clearBranchOverlayCache,
  loadBranchOverlay,
} from "./branch-overlay.js";
export {
  BUILD_PLUGIN_METHODS,
  type BuildPluginMethod,
  type BuildPluginServices,
  decodeBuildPayload,
  encodeBuildPayload,
  isBuildPluginMethod,
  localBuildPluginServices,
  remoteBuildPluginServices,
  renderPluginOnLiveBuild,
  type StaticRenderContext,
  type StaticRenderPlugin,
  serveBuildPluginCall,
} from "./build-services.js";
export { makePluginContext } from "./capabilities.js";
// #1267 — plugins react to the change journal (replaces #1214's module push).
export {
  type ChangeConsumersHandle,
  changeConsumerName,
  type DrainLimits,
  type DrainReport,
  drainChangeConsumers,
  drainChangeConsumersOnTick,
  ensureChangeConsumers,
  pluginChangeFilter,
  resumeDueChangeConsumers,
  startChangeConsumers,
} from "./change-consumers.js";
export {
  collectBuildAssets,
  dataBlockJson,
  injectPluginAssets,
  PLUGIN_ASSET_DIR,
  PLUGIN_DATA_FILE,
  type PluginClientAsset,
  withAssetContent,
} from "./client-assets.js";
export {
  AI_CHAT_SEARCH_HITS,
  aiChatToolParams,
  type CollectionAnswer,
  type HitExplanation,
  MAX_QUERY_WORDS,
  ModelUnavailableError,
  modelOfFingerprint,
  normalizeQuery,
  type OpenEntry,
  type QueryEmbedder,
  type RunCollectionOptions,
  runCollectionOperation,
  type WarmableQueryEmbedder,
  wasmQueryEmbedder,
} from "./collection-query.js";
export {
  COLLECTION_OPS,
  type CollectionChangeFile,
  collectionDocSchema,
  collectionPrefix,
  collectionStoreFromEnv,
  decodeChangeFile,
  encodeChangeFile,
  LIVE_COLLECTION_STORE_ENV,
  makePluginChatTools,
  makePluginCollections,
  registerCollectionOps,
  resetCollectionStores,
  STAGING_COLLECTION_STORE_ENV,
} from "./collections-host.js";
export {
  type ConfigurablePlugin,
  configurablePlugins,
  ensureConfigOps,
  hasConfig,
} from "./config-handle.js";
export {
  consentPurposeDeclared,
  declaredConsentPurposes,
  pluginDeclaresConsentPurpose,
} from "./consent-purposes.js";
export {
  type ContentVariantField,
  checkContentVariantValues,
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
  makeInvocationContext,
  type PluginHostInfra,
  pluginToolSurfaceGeneration,
  type RenderScope,
  type RunPluginOperationOpts,
  type RunPluginOperationResult,
  renderInvocation,
  resetDisabledSet,
  runPluginMetaSignature,
  runPluginMetaSignatureBatch,
  runPluginOperation,
  runPluginStaticRender,
  setPluginDisabled,
  toolArgsProblem,
  type VisitorDispatchContext,
} from "./dispatch.js";
export { operatorHasPermission } from "./external-authorization.js";
export { resolvePreviewFonts } from "./font-preview.js";
export {
  bootstrapDispatchOnly,
  type DispatchOnlyBootstrapOpts,
  markDispatchRegistryStale,
  resetDispatchOnlyHost,
  SYNC_TTL_MS,
  servesVisitorOperations,
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
  HEAD_CONTRIBUTION_PAGES_PER_CALL,
  type ResolvedHeadEntry,
  type ResolvedSitemapContribution,
  renderHeadEntries,
} from "./head-composition.js";
export { checkHeadAnswer, headEntryRule } from "./head-vocabulary.js";
export {
  finishImageRequest,
  type ImageRequestRecord,
  markImageRequestUncertain,
  readImageRequest,
  reserveImageRequest,
} from "./image-ledger.js";
export { checkPluginRuntime, type PluginRuntimeReport } from "./image-self-check.js";
export {
  forgetIndexLeadColumns,
  indexLeadColumns,
  type ListIndexAccess,
  listAccessOf,
  listIndexRefusal,
  rememberedIndexLeadColumns,
} from "./index-coverage.js";
// #1659 — the Stage keeps an upserted key of a private table at one row.
export { type MergedPluginRow, mergePluginRows, type WrittenPluginRow } from "./key-merge.js";
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
  clearLinkResolveCache,
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
export { markedSourceEntries, sourcesMarkedFor } from "./list-source-overlays.js";
export {
  checkListSourceEntries,
  dormantListSourceNames,
  LIST_SOURCE_ANSWER_MAX_BYTES,
  type ResolvedListSources,
  resolveListSources,
  sourceEntriesOf,
} from "./list-source-resolution.js";
export { pluginListSourcesRegistry } from "./list-sources.js";
export {
  AWAITING_CAPABILITY_APPROVAL,
  activateApprovedExternalPlugin,
  type BootstrapOpts,
  bootstrap,
  type LoadReport,
  loadActivatedPlugin,
  pluginHostBootstrapped,
  resetPluginHost,
  verifyDiskPlugin,
} from "./loader.js";
// #1008 — whether a plugin runs in this process: where its skills are
// available, and what the Publish-live gate checks every active plugin against.
export {
  pluginFailedHereReason,
  pluginRunsHere,
} from "./local-availability.js";
export { verifyMailUnsubscribeToken } from "./mail-link-token.js";
// #1340 — a plugin as its manifest alone (the gateway's view).
export {
  declarativeDefinition,
  resolveTrustRoot,
  unapprovedCapabilities,
  verifyDiskManifest,
} from "./manifest-definition.js";
export {
  type ComposedModuleRef,
  extractPageHtmlFacts,
  type PageHtmlFacts,
  type PageHtmlInput,
  type PageHtmlLink,
  type PageHtmlText,
  type PageOutputZone,
  pageHtmlHash,
  sitePathOf,
} from "./page-output-facts.js";
export {
  type DeliveredPage,
  finishPageOutput,
  hasGrantedCapability,
  type OfferedPage,
  observePageOutputs,
  type PageOutputFinish,
  pageOutputNeeds,
  pageOutputObservers,
  resetPageOutputRuns,
} from "./page-output-host.js";
export {
  applyApprovedConfig,
  CONFIG_OPS,
  type ConfigChange,
  type ConfigFieldInfo,
  type ConfigPluginLookup,
  describeConfig,
  describeEntityConfig,
  entityRowId,
  gatedLeaves,
  hostRowId,
  loadedConfigLookup,
  parsedConfigOf,
  previewConfigPatch,
} from "./plugin-config.js";
export {
  activeDependentsOf,
  dependentsMessage,
  type InactiveRequirement,
  inactiveRequiredPlugins,
  requiredPluginsOf,
  requirementsMessage,
} from "./plugin-dependencies.js";
// Epic #1644 (R5, #1646) — plugin batches in a job container.
export { notifyPluginRegistered, onPluginRegistered } from "./plugin-registered.js";
export { type ListPlan, type PluginRowLocker, privateListSql } from "./private-storage.js";
export {
  type PromptContextRenderer,
  pluginPromptContextRegistry,
} from "./prompt-context-registry.js";
export { COMMENT_THREAD_PAGE_SIZE } from "./public-blocks/comment-thread.js";
export { optInEmailHash } from "./public-blocks/mail-blocks.js";
export { argon2InFlight } from "./public-blocks/visitor-auth.js";
export {
  GENERIC_VISITOR_FAILURE,
  refusePublicCall,
  VISITOR_TRANSPORT_FIELDS,
  visitorSafeResult,
} from "./public-contract.js";
// #1340 — public operations run as declarations (core code), never plugin code.
export { runDeclaredPublicOperation } from "./public-run-host.js";
export {
  dropPluginPublicSchemas,
  type PluginPublicSchemaSpec,
  provisionPluginPublicSchemas,
} from "./public-schemas.js";
export {
  type PublicUrlContext,
  type PublicUrlPage,
  resolvePublicPageUrls,
} from "./public-urls.js";
export { unpublishedRegistryError } from "./published-state.js";
export {
  type PublishedVisitorConfigReader,
  publishedVisitorConfig,
  setPublishedVisitorConfigReader,
} from "./published-visitor-config.js";
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
// #1361 — the plugin host's part of every admin request's start.
export { pluginHostRequestStart } from "./request-start.js";
export {
  applyPluginRowState,
  discardBranchPluginRows,
  insertPluginRowSnapshot,
  loadBranchRowStates,
  type PluginRowRef,
  type PluginRowState,
  withPluginScope,
} from "./row-snapshots.js";
export {
  HEARTBEAT_REFRESH_MS,
  holdRuntimeHeartbeat,
  hostInstanceId,
  LIVE_WINDOW_MS,
  refreshRuntimeHeartbeat,
  stopRuntimeHeartbeat,
} from "./runtime-health.js";
export type { SandboxKind } from "./sandbox-kind.js";
export { SANDBOX_BATCH_CALL_LIMIT, sandboxMethod } from "./sandbox-protocol.js";
export {
  brokerSandboxCall,
  runSandbox,
  SANDBOX_BUDGETS,
  SANDBOX_POOLS,
  sandboxSlotsInUse,
} from "./sandbox-runtime.js";
export {
  pluginWorkerScheduler,
  type ScheduledWorker,
  type UnscheduledWorker,
} from "./scheduler.js";
export {
  type RefusedShareImage,
  type ResolvedShareImages,
  resolveShareImages,
  SHARE_IMAGES_PAGES_PER_CALL,
} from "./share-images.js";
export {
  parseListFilter,
  publicListSql,
  registerPluginStorageOps,
  STORAGE_OPS,
} from "./storage-ops.js";
export { recordExternalToolApproval } from "./tool-approval-binding.js";
export {
  pluginToolsRegistry,
  type RegisteredPluginTool,
} from "./tools-registry.js";
export type { AICompletion, AIMessage, AIObjectCompletion, AIProvider } from "./types.js";
export { STAGE_KEY_LOCKS_PER_TABLE } from "./upsert-key-locks.js";
export {
  collectUrlAnnotations,
  type DecodedPagePath,
  decodePagePath,
  pathEndsInSlug,
  type RegisteredUrlContribution,
  type ResolvedPageUrl,
  resolvePageUrl,
  type UrlCompositionView,
  urlAnnotationPluginSlugs,
  urlContributionsRegistry,
} from "./url-composition.js";
// #1729 (Q7 A) — URL slots declared as tables the host reads.
export {
  type DeclaredUrlValue,
  declaredUrlContributions,
  readDeclaredUrlValues,
  servedPublicHosts,
} from "./url-tables.js";
export {
  parseVisitorConsentHeader,
  resolveVisitorConsentRule,
  VISITOR_CONSENT_HEADER,
  VISITOR_ID_PURPOSE,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "./visitor-consent.js";
export {
  collectPluginWriteHints,
  type PluginWriteHintsResult,
  writeHintContributors,
} from "./write-hints.js";
