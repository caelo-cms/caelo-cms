// SPDX-License-Identifier: MPL-2.0

/**
 * Whether the update Settings → Updates shows as "running" has a run that
 * died (#696, #819): Cloud Run knows a run ended even when it never wrote
 * its end, so the page says so instead of "Installing" until the 90-minute
 * stale cut-off ends it.
 *
 * Two shapes of a dead run on Google Cloud (#819 review, #1029):
 *
 *   - the request names its execution and Cloud Run says that execution is
 *     no longer running (out of memory, task timeout);
 *   - the request names NO execution — stage 1 handed it over and the
 *     stage-2 run never started (its start failed, or it was cancelled
 *     before it claimed) — and the job has no live run either. Without
 *     this the Owner waited 90 minutes for the stale end before Continue.
 *
 * Both jobs adopt such a request, so the Owner may Continue it: the converge
 * job resumes from its checkpoint, the upgrader starts over from its checks.
 * The self-hosted agent adopts nothing: its dead run is ended by the next
 * request and simply tried again.
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
  opts: {
    readonly canInstall: boolean;
    readonly logsUrl: string;
    /** The install's jobs adopt a request (Google Cloud), not the self-hosted agent. */
    readonly jobsAdopt: boolean;
  },
): { readonly logsUrl: string; readonly continuable: boolean } | null {
  if (active?.status !== "running") return null;
  const continuable = opts.jobsAdopt && opts.canInstall;
  if (active.execution) {
    if (latest && latest.execution === active.execution && latest.state !== "running") {
      return { logsUrl: latest.logsUrl, continuable };
    }
    return null;
  }
  // No execution named: only a job between its two stages gets here.
  if (!opts.jobsAdopt) return null;
  if (latest && latest.state === "running") return null;
  return { logsUrl: latest?.logsUrl ?? opts.logsUrl, continuable };
}
