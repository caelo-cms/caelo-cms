// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-host — P11.5 Tier-1 plugin runtime.
 *
 * Bootstrap walks `packages/plugins/<slug>/`, verifies signatures, runs the
 * validator, and registers each Tier-1 plugin's tools + workers + prompt-
 * context renderers + actor row. Operations dispatch via runPluginOperation;
 * background workers tick on schedule. Tier 2 plugins go through the existing
 * P11 lifecycle (submit → activate → cms_public schema provisioned).
 */

export {
  type EmailTransport,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
  type RunPluginOperationOpts,
  type RunPluginOperationResult,
  resetDisabledSet,
  runPluginMetaSignature,
  runPluginMetaSignatureBatch,
  runPluginOperation,
  runPluginStaticRender,
  type SnapshotEmitter,
  type SnapshotEmitterInput,
  setPluginDisabled,
  type VisitorDispatchContext,
} from "./dispatch.js";
export { applyPluginLifecycle } from "./lifecycle.js";
export { type BootstrapOpts, bootstrap, type LoadReport, resetPluginHost } from "./loader.js";
export {
  type PromptContextRenderer,
  pluginPromptContextRegistry,
} from "./prompt-context-registry.js";
export {
  pluginWorkerScheduler,
  type ScheduledWorker,
} from "./scheduler.js";
export {
  pluginToolsRegistry,
  type RegisteredPluginTool,
} from "./tools-registry.js";

export type { AIMessage, AIProvider } from "./types.js";
