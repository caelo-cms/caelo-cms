// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/lifecycle — admin-core's plugins.disable / activate
 * ops call this after the DB write to keep the live host's registries in
 * sync. Without it, disable just flips a status row and leaves tools +
 * workers running until process restart.
 */

import { pluginDataListsRegistry } from "./data-lists.js";
import { loadedPlugins, setPluginDisabled } from "./dispatch.js";
import { pluginPromptContextRegistry } from "./prompt-context-registry.js";
import { pluginWorkerScheduler } from "./scheduler.js";
import { pluginToolsRegistry } from "./tools-registry.js";
import { urlContributionsRegistry } from "./url-composition.js";

export type PluginLifecycleAction = "disable" | "enable";

export function applyPluginLifecycle(slug: string, action: PluginLifecycleAction): void {
  switch (action) {
    case "disable":
      setPluginDisabled(slug, true);
      pluginWorkerScheduler.pausePlugin(slug);
      return;
    case "enable":
      setPluginDisabled(slug, false);
      pluginWorkerScheduler.resumePlugin(slug);
      return;
  }
}

/**
 * #393 — full runtime removal for uninstall: the plugin disappears from
 * every registry (tools, prompt context, workers, URL contributions,
 * the loaded-plugins map). Unlike disable, this is not reversible
 * without a fresh bootstrap — the uninstall op deletes the DB rows and
 * drops the schemas right after.
 */
export function deregisterPlugin(slug: string): void {
  setPluginDisabled(slug, false);
  pluginWorkerScheduler.unschedulePlugin(slug);
  pluginToolsRegistry.unregisterPlugin(slug);
  // Live sources only — the DECLARED names stay, so a module still
  // holding `{{#its_list}}` renders "plugin switched off" instead of
  // "unknown field".
  pluginDataListsRegistry.unregisterPlugin(slug);
  pluginPromptContextRegistry.unregisterPlugin(slug);
  urlContributionsRegistry.unregisterPlugin(slug);
  loadedPlugins.unload(slug);
}
