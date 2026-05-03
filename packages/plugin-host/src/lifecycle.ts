// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-host/lifecycle — admin-core's plugins.disable / activate
 * ops call this after the DB write to keep the live host's registries in
 * sync. Without it, disable just flips a status row and leaves tools +
 * workers running until process restart.
 */

import { setPluginDisabled } from "./dispatch.js";
import { pluginWorkerScheduler } from "./scheduler.js";

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
