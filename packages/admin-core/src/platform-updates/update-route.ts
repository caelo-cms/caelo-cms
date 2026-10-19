// SPDX-License-Identifier: MPL-2.0

/**
 * Which job installs the release the Owner clicked Update for (#819):
 *
 *   - `app_roll` — the upgrader job: new images and expand-only migrations
 *     under its own narrow service account;
 *   - `converge` — the converge job: the whole upgrade (backup, cloud-setup
 *     changes, roll, health check, rollback) as the install's provisioner,
 *     for a release that raises the infrastructure contract.
 *
 * The Owner sees the same button and the same timeline either way; this
 * only picks the job, from what the release manifest says (read, not
 * verified — release-facts.ts) and how the last attempt at the same
 * release ended. Either job re-checks everything against the signed
 * manifest before it changes anything, so a wrong guess here costs a
 * refused run, never a wrong install.
 */

import type { PlatformUpdateRoute, PlatformUpdateStatusValue } from "@caelo-cms/shared";

/** The most recent update request, as far as routing cares. */
export interface LastUpdateAttempt {
  readonly targetVersion: string;
  readonly status: PlatformUpdateStatusValue;
  readonly route: PlatformUpdateRoute;
  readonly refusalCodes: readonly string[];
}

export interface UpdateRouteInput {
  /** `CAELO_PROVIDER` as Settings → Updates resolves it. */
  readonly provider: string | undefined;
  readonly targetVersion: string;
  /**
   * The release raises the infrastructure contract over the running one
   * (release-facts.ts `infraChange`); null when the manifests could not
   * be read.
   */
  readonly infraChange: boolean | null;
  readonly lastAttempt: LastUpdateAttempt | null;
  /** This install has a converge job the admin can start. */
  readonly convergeAvailable: boolean;
}

export type UpdateRoute =
  | { readonly ok: true; readonly route: PlatformUpdateRoute; readonly why: string }
  | { readonly ok: false; readonly error: string };

/**
 * Pick the job for `targetVersion`. A converge is chosen when the manifest
 * says the release changes the cloud setup, when the upgrader already
 * answered so for this release (`infra-contract`), or to continue a
 * converge of this release that did not finish (the converge job resumes
 * from its checkpoint). Refuses — with what the Owner does instead — when
 * a converge is needed and this install cannot run one from here.
 */
export function chooseUpdateRoute(input: UpdateRouteInput): UpdateRoute {
  // Self-hosted: the target's own CLI renders the host setup in the same
  // run (release-facts.ts); there is nothing to converge separately.
  if (input.provider === "self-hosted") {
    return { ok: true, route: "app_roll", why: "self-hosted installs update in one step" };
  }
  const last = input.lastAttempt?.targetVersion === input.targetVersion ? input.lastAttempt : null;
  const why =
    input.infraChange === true
      ? "the release changes the install's cloud setup"
      : last?.status === "needs_cloud_shell" && last.refusalCodes.includes("infra-contract")
        ? "the upgrader found that the release changes the install's cloud setup"
        : last?.route === "converge" && last.status !== "succeeded"
          ? "continuing an earlier converge of this release"
          : null;
  if (why === null) {
    return { ok: true, route: "app_roll", why: "no change to the cloud setup" };
  }
  if (input.provider === "aws" || input.provider === "azure") {
    // FIXME(issue #696): AWS and Azure have no in-cloud upgrader or converge
    // job yet (CLAUDE.md §11.B/§11.C want the same shape on every adapter).
    // Until they do, a cloud-setup release is refused here with the command
    // that installs it; the refusal must stay honest, never a silent no-op.
    return {
      ok: false,
      error: `v${input.targetVersion} changes this install's cloud setup. Installing such releases from Caelo is available on Google Cloud installs only so far; on ${input.provider === "aws" ? "AWS" : "Azure"} run the upgrade from the computer you installed from (the provisioning CLI).`,
    };
  }
  if (!input.convergeAvailable) {
    return {
      ok: false,
      error: `v${input.targetVersion} also changes settings in your Google Cloud project, which this site cannot do by itself. Install it from Google Cloud Shell or the computer you installed from (Settings → Updates shows how). On an install with Caelo's provisioner account, that run also sets Caelo up to install such updates itself next time.`,
    };
  }
  return { ok: true, route: "converge", why };
}
