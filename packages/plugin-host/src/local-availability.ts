// SPDX-License-Identifier: MPL-2.0

/**
 * Whether a plugin runs in THIS process (issue #1008).
 *
 * A plugin's skills are available exactly where its tools are: in a
 * process that has the plugin loaded. The Owner's status says the plugin
 * should run; a load that failed here means its tools are absent here, so
 * its skills must not be offered here either — `load_skill` would hand the
 * AI instructions to call tools that do not exist. This is runtime state of
 * one process, so it lives in the host, not in the database: another
 * server's failure never hides a skill on a server where the plugin runs.
 *
 * Only the current state lives here. A chat's pinned `# Skills` index does
 * not derive its past from it: what the index left out is stored with the
 * chat when the index is first built (`chat.pin_skills_index`).
 */

import { isPluginDisabled, loadedPlugins } from "./dispatch.js";

/** Why each plugin whose last load in this process failed does not run here. */
const failedHere = new Map<string, string>();

/** Note the outcome of loading `slug` in this process. */
export function noteLocalLoadOutcome(slug: string, loaded: boolean, reason: string | null): void {
  if (loaded) failedHere.delete(slug);
  else failedHere.set(slug, reason ?? "it did not load (no reason given)");
}

/** Whether `slug` runs in this process: loaded and not stopped. */
export function pluginRunsHere(slug: string): boolean {
  return loadedPlugins.bySlug(slug) !== undefined && !isPluginDisabled(slug);
}

/** Why `slug` does not run in this process, when its last load here failed. */
export function pluginFailedHereReason(slug: string): string | null {
  return failedHere.get(slug) ?? null;
}

/** Forget every outcome (tests, host reset). */
export function resetLocalLoadOutcomes(): void {
  failedHere.clear();
}
