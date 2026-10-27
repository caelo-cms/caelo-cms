// SPDX-License-Identifier: MPL-2.0

/**
 * #779 — the site-level Draft → Preview → Live summary on the dashboard,
 * derived from real data only: draft pages from `pages.list`, the newest
 * succeeded staging and production builds from `deploy.list_runs`.
 *
 * "Live matches staging" uses the same rule as the /edit toolbar:
 * `deploy.promote` stamps the source staging run id into the production
 * run's `buildId`, so production serves the latest staged build exactly
 * when the two ids agree. A direct production build carries a fresh
 * build id and therefore never "matches".
 */

/** The `deploy.list_runs` row fields this summary reads. */
export interface DeployRunSummary {
  id: string;
  targetName: string;
  status: string;
  finishedAt: string | null;
  buildId: string | null;
  /** #1155 — `plugin_data` runs republish the live build with fresher plugin data only. */
  buildKind: "site" | "plugin_data";
}

/** One finished build: when it finished. */
export interface FinishedBuild {
  runId: string;
  finishedAt: string;
}

export interface SiteState {
  /** Pages with status `draft` — in no build at all. */
  draftPageCount: number;
  /** Newest succeeded staging build, or null when nothing was staged. */
  preview: FinishedBuild | null;
  /** Newest succeeded production build, or null when nothing is live. */
  live: FinishedBuild | null;
  /**
   * Whether production serves the newest staged build. Null when either
   * build is missing — there is nothing to compare.
   */
  liveMatchesPreview: boolean | null;
}

/**
 * Build the dashboard summary.
 *
 * @param pages every page's status (from `pages.list`).
 * @param runs recent deploy runs, newest first (as `deploy.list_runs`
 *   returns them).
 */
export function siteStateFrom(
  pages: ReadonlyArray<{ status: string }>,
  runs: ReadonlyArray<DeployRunSummary>,
): SiteState {
  // A plugin-data build (#1155) changes no content: what is "live" for
  // this summary is the build a human published, which it built on.
  const newest = (targetName: string): DeployRunSummary | undefined =>
    runs.find(
      (r) =>
        r.targetName === targetName &&
        r.status === "succeeded" &&
        r.finishedAt &&
        r.buildKind !== "plugin_data",
    );
  const staged = newest("staging");
  const production = newest("production");
  const asBuild = (r: DeployRunSummary | undefined): FinishedBuild | null =>
    r?.finishedAt ? { runId: r.id, finishedAt: r.finishedAt } : null;
  return {
    draftPageCount: pages.filter((p) => p.status === "draft").length,
    preview: asBuild(staged),
    live: asBuild(production),
    liveMatchesPreview: staged && production ? production.buildId === staged.id : null,
  };
}
