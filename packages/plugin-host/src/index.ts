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
export { pluginManifest } from "@caelo-cms/plugin-sdk";
export { makePluginContext } from "./capabilities.js";
export {
  collectBuildAssets,
  injectPluginAssets,
  PLUGIN_ASSET_DIR,
  type PluginClientAsset,
} from "./client-assets.js";
export {
  type ResolvedDataLists,
  resolveDataLists,
} from "./data-list-resolution.js";
export { type DataListItem, pluginDataListsRegistry } from "./data-lists.js";
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
  type VisitorDispatchContext,
} from "./dispatch.js";
export { operatorHasPermission } from "./external-authorization.js";
export { resolvePreviewFonts } from "./font-preview.js";
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
export { applyPluginLifecycle, deregisterPlugin } from "./lifecycle.js";
export {
  activateApprovedExternalPlugin,
  type BootstrapOpts,
  bootstrap,
  type LoadReport,
  loadActivatedPlugin,
  resetPluginHost,
} from "./loader.js";
export type { PluginRowLocker } from "./private-storage.js";
export {
  type PromptContextRenderer,
  pluginPromptContextRegistry,
} from "./prompt-context-registry.js";
export {
  applyPluginRowState,
  discardBranchPluginRows,
  insertPluginRowSnapshot,
  type PluginRowRef,
  type PluginRowState,
  withPluginScope,
} from "./row-snapshots.js";
export {
  pluginWorkerScheduler,
  type ScheduledWorker,
} from "./scheduler.js";
export { recordExternalToolApproval } from "./tool-approval-binding.js";
export {
  pluginToolsRegistry,
  type RegisteredPluginTool,
} from "./tools-registry.js";
export type { AIMessage, AIProvider } from "./types.js";
export {
  collectUrlAnnotations,
  type DecodedPagePath,
  decodePagePath,
  type RegisteredUrlContribution,
  type ResolvedPageUrl,
  resolvePageUrl,
  urlContributionsRegistry,
} from "./url-composition.js";
