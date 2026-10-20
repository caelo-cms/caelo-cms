// SPDX-License-Identifier: MPL-2.0

/**
 * Whether the update Settings → Updates shows as "running" has a run that
 * died (#696, #819): Cloud Run knows a run ended even when it never wrote
 * its end, so the page says so instead of "Installing" until the 90-minute
 * stale cut-off ends it.
 *
 * Two shapes of a dead converge (#819 review):
 *
 *   - the request names its execution and Cloud Run says that execution is
 *     no longer running (out of memory, task timeout);
 *   - the request names NO execution — stage 1 handed it over and the
 *     stage-2 run never started (its start failed, or it was cancelled
 *     before it claimed) — and the job has no live run either. Without
 *     this the Owner waited 90 minutes for the stale end before Continue.
 *
 * A converge resumes from its checkpoint, so the Owner may Continue it; a
 * dead app-roll run is ended by the next request and simply tried again.
 */

/** The request as far as this cares. */
export interface ActiveRequest {
  readonly status: string;
  readonly route: "app_roll" | "converge";
  readonly execution: string | null;
}

/** The job's latest run, as its trigger reports it (null: it never ran). */
export interface LatestRun {
  readonly execution: string;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly logsUrl: string;
}

/** The dead run, or null when the request is not running or its run lives. */
export function deadRunOf(
  active: ActiveRequest | null,
  latest: LatestRun | null,
  opts: { readonly canInstall: boolean; readonly logsUrl: string },
): { readonly logsUrl: string; readonly continuable: boolean } | null {
  if (active?.status !== "running") return null;
  const continuable = active.route === "converge" && opts.canInstall;
  if (active.execution) {
    if (latest && latest.execution === active.execution && latest.state !== "running") {
      return { logsUrl: latest.logsUrl, continuable };
    }
    return null;
  }
  // No execution named: only a converge between its two stages gets here.
  if (active.route !== "converge") return null;
  if (latest && latest.state === "running") return null;
  return { logsUrl: latest?.logsUrl ?? opts.logsUrl, continuable };
}
