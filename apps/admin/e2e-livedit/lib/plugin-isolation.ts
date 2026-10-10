// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin activation is site state that outlives a scenario. Scenarios share
 * one admin process and one database (workers: 1), and the per-scenario
 * `resetLiveditFixtures()` wipes content, not plugin activation — it cannot:
 * the running plugin host keeps its own "disabled" flag, which only the
 * admin's disable action flips. So a plugin one scenario switched on stayed
 * on for every scenario after it.
 *
 * PR #641's run is what that costs: the consent scenario activated
 * `consent-manager`; the homepage scenario after it then ran on a site that
 * injects the consent runtime (whose console noise the AI tried to "fix" by
 * building a cookie banner, which then covered the published page in the
 * vision check) and withholds third-party embeds (which hid the site header
 * on the retry and cost six extra loops).
 *
 * The suite's auto fixture snapshots the active plugins before each test
 * and, after it, disables every plugin the test switched on — through the
 * admin, so the live host follows.
 */

/**
 * The plugins a test activated: active after it, not before it. Sorted so
 * the restore order (and its log) is stable.
 *
 * @param before active plugin slugs when the test started
 * @param after active plugin slugs when it ended
 */
export function pluginsActivatedDuring(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const was = new Set(before);
  return [...new Set(after)].filter((slug) => !was.has(slug)).sort();
}
