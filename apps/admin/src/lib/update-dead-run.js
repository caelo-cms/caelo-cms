// SPDX-License-Identifier: MPL-2.0
/** The dead run, or null when the request is not running or its run lives. */
export function deadRunOf(active, latest, opts) {
    if (active?.status !== "running")
        return null;
    const continuable = active.route === "converge" && opts.canInstall;
    if (active.execution) {
        if (latest && latest.execution === active.execution && latest.state !== "running") {
            return { logsUrl: latest.logsUrl, continuable };
        }
        return null;
    }
    // No execution named: only a converge between its two stages gets here.
    if (active.route !== "converge")
        return null;
    if (latest && latest.state === "running")
        return null;
    return { logsUrl: latest?.logsUrl ?? opts.logsUrl, continuable };
}
