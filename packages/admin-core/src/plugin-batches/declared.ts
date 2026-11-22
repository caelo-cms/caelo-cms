// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1646) — which batch operation a plugin declares and may run.
 * Its own module because both the ops (start, enqueue) and the job kind
 * (the run that claims it) ask, and the job kind must not import the ops:
 * they start jobs through the launcher, which imports the job kinds.
 */

import { hasGrantedCapability, isPluginDisabled, type LoadedPlugin } from "@caelo-cms/plugin-host";
import type { PluginBatchOperation } from "@caelo-cms/plugin-sdk";

/** The declared batch of a loaded, active plugin with the grant, or why not. */
export function declaredBatch(
  plugin: LoadedPlugin | undefined,
  operation: string,
): { ok: true; batch: PluginBatchOperation } | { ok: false; message: string } {
  if (!plugin) return { ok: false, message: "the plugin is not active on this site" };
  if (isPluginDisabled(plugin.slug))
    return { ok: false, message: `plugin "${plugin.slug}" is disabled (Settings → Plugins)` };
  if (!hasGrantedCapability(plugin, "batch_jobs"))
    return {
      ok: false,
      message: `plugin "${plugin.slug}" was not granted batch jobs: an Owner approves the capability in Settings → Plugins`,
    };
  const batches = (plugin.definition.batchOperations ?? []) as PluginBatchOperation[];
  const batch = batches.find((b) => b.operation === operation);
  if (!batch) {
    const names = batches.map((b) => b.operation);
    return {
      ok: false,
      message: `plugin "${plugin.slug}" declares no batch "${operation}"${names.length > 0 ? `; it declares ${names.join(", ")}` : ""}`,
    };
  }
  return { ok: true, batch };
}
