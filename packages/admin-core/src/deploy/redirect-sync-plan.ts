// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — the redirect plan a saved redirects table puts live, computed
 * against the files of the build the target serves right now.
 *
 * Redirects reach the hosting provider when they are saved, not with a build
 * (deploy/redirect-sync.ts). The plan's rule "the build wins" (a row whose
 * from path a file serves is left out, `buildRedirectPlan`) therefore has to
 * be checked against the LIVE build's files, which every publisher reads from
 * its provider: the Firebase Hosting version on the channel, the live bucket,
 * the `current/` directory Caddy serves. This module is the provider-neutral
 * part every publisher shares.
 */

import {
  buildRedirectPlan,
  type RedirectPageUrlStyle,
  type RedirectPlan,
  type RedirectTableRow,
  redirectsToUnservedPaths,
} from "@caelo-cms/shared";

/** A redirect pointing at a path the served build does not have (a draft page). */
export interface UnservedRedirectTarget {
  readonly fromPath: string;
  readonly location: string;
}

/** The plan plus the counts a sync records. */
export interface RedirectSyncPlan {
  readonly plan: RedirectPlan;
  readonly redirectCount: number;
  readonly goneCount: number;
  readonly shadowedCount: number;
  readonly unservedTargets: readonly UnservedRedirectTarget[];
}

/**
 * Build the plan for `rows` against `servedFiles` (relative paths, no
 * leading slash). Throws what `buildRedirectPlan` throws for a row no host
 * can serve (a loop, a conflicting duplicate): the sync then fails loudly
 * with the fix in the message.
 */
export function planRedirectSync(
  rows: readonly RedirectTableRow[],
  pageUrlStyle: RedirectPageUrlStyle,
  servedFiles: ReadonlySet<string>,
): RedirectSyncPlan {
  const plan = buildRedirectPlan({ rows, pageUrlStyle, servedFiles });
  return {
    plan,
    redirectCount: plan.redirects.length,
    goneCount: plan.gone.length,
    shadowedCount: plan.shadowedByBuild.length,
    unservedTargets: redirectsToUnservedPaths(plan, servedFiles).map((r) => ({
      fromPath: r.fromPath,
      location: r.location,
    })),
  };
}
