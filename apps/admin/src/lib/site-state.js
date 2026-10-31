// SPDX-License-Identifier: MPL-2.0
/**
 * Build the dashboard summary.
 *
 * @param pages every page's status (from `pages.list`).
 * @param runs recent deploy runs, newest first (as `deploy.list_runs`
 *   returns them).
 */
export function siteStateFrom(pages, runs) {
    // A plugin-data build (#1155) changes no content: what is "live" for
    // this summary is the build a human published, which it built on.
    const newest = (targetName) => runs.find((r) => r.targetName === targetName &&
        r.status === "succeeded" &&
        r.finishedAt &&
        r.buildKind !== "plugin_data");
    const staged = newest("staging");
    const production = newest("production");
    const asBuild = (r) => r?.finishedAt ? { runId: r.id, finishedAt: r.finishedAt } : null;
    return {
        draftPageCount: pages.filter((p) => p.status === "draft").length,
        preview: asBuild(staged),
        live: asBuild(production),
        liveMatchesPreview: staged && production ? production.buildId === staged.id : null,
    };
}
