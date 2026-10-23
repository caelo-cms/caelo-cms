// SPDX-License-Identifier: MPL-2.0

/**
 * Whether a plugin runs in THIS process, and since when (issue #1008).
 *
 * A plugin's skills are available exactly where its tools are: in a
 * process that has the plugin loaded. The Owner's status says the plugin
 * should run; a load that failed here means its tools are absent here, so
 * its skills must not be offered here either — `load_skill` would hand the
 * AI instructions to call tools that do not exist. This is runtime state of
 * one process, so it lives in the host, not in the database: another
 * server's failure never hides a skill on a server where the plugin runs.
 *
 * The time of the last change matters for the `## Skills` index, which is
 * pinned to what was available when a chat began (CLAUDE.md §2): a skill
 * whose plugin failed after the chat started stays in that chat's index
 * (the chat is told in its history instead), and one whose plugin
 * recovered after the chat started is announced instead of edited in.
 */

import { isPluginDisabled, loadedPlugins } from "./dispatch.js";

interface LocalOutcome {
  readonly loaded: boolean;
  /** When this process last switched between loaded and not; 0 = its first outcome. */
  readonly since: number;
  /** Why it does not run here, when it does not. */
  readonly reason: string | null;
}

const outcomes = new Map<string, LocalOutcome>();

/**
 * Note the outcome of loading `slug` in this process. The first outcome
 * counts as "always so" (since 0): a process that never ran the plugin has
 * nothing earlier to pin a chat to.
 */
export function noteLocalLoadOutcome(slug: string, loaded: boolean, reason: string | null): void {
  const prev = outcomes.get(slug);
  if (prev && prev.loaded === loaded) {
    outcomes.set(slug, { ...prev, reason });
    return;
  }
  outcomes.set(slug, { loaded, since: prev ? Date.now() : 0, reason });
}

/** Whether `slug` runs in this process: loaded and not stopped. */
export function pluginRunsHere(slug: string): boolean {
  return loadedPlugins.bySlug(slug) !== undefined && !isPluginDisabled(slug);
}

/** Why `slug` does not run in this process, when a load here failed. */
export function pluginFailedHereReason(slug: string): string | null {
  const o = outcomes.get(slug);
  return o && !o.loaded ? o.reason : null;
}

/**
 * Whether `slug` ran in this process at time `at` (epoch ms): its state now,
 * unless it switched after `at` — then the opposite.
 */
export function pluginRanHereAt(slug: string, at: number): boolean {
  const now = pluginRunsHere(slug);
  const o = outcomes.get(slug);
  return o && o.since > at ? !now : now;
}

/** Forget every outcome (tests, host reset). */
export function resetLocalLoadOutcomes(): void {
  outcomes.clear();
}
