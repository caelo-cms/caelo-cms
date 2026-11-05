// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job (#819): installs a signed Caelo release that changes the
 * install's cloud setup (raises the infrastructure contract), from inside
 * the install's own project, started by the Owner's Update + password in
 * Settings → Updates. It runs as the install's `caelo-provisioner` account
 * (converge-job-setup.ts has the trust boundary); the upgrader job, which
 * only rolls images, keeps every other release.
 *
 * One job, two stages, told apart by the release this code belongs to:
 *
 *   Stage 1 — the job still runs the ops image of the INSTALLED release.
 *     It claims the request, reads install.json from the ops bucket,
 *     fetches the target's release manifest from the FIXED registry and
 *     verifies its signature (release-manifest.ts), and decides
 *     (upgrader-assess.ts, `route: "converge"`): no downgrade, nothing
 *     below minFromVersion, no automatic converge unless the policy allows
 *     it; then it checks its own IAM access (converge-job-preflight.ts) and
 *     stops on anything missing — except a role of the self-grant
 *     allowlist, which it leaves to stage 2.
 *     Then it verifies the target's ops image, points this job at it BY DIGEST and starts a new
 *     execution, handing the request over to it. It changes nothing else:
 *     the converge logic always comes from the release it installs.
 *
 *   Stage 2 — the job runs the TARGET release's ops image (its own
 *     version is the request's). It verifies the manifest again, checks
 *     that the image it runs is the one the manifest signs, takes the
 *     install's state lock (#815; the upgrader job and the terminal
 *     `upgrade` take the same one, so they exclude each other), grants its
 *     own account the allowlisted roles the self-check found missing (each
 *     a timeline event; IAM is asked again before it goes on), and runs
 *     the very upgrade the terminal runs (upgrade/upgrade.ts): backup →
 *     converge + app-roll → deep health check, rollback on failure →
 *     install.json + the infrastructure contract → the request's end.
 *
 * Resume. Every stage-2 fact a successor must not recompute (the backup,
 * the revisions that served before, the release it judges from) is in the
 * checkpoint (converge-checkpoint.ts). A killed execution leaves its
 * request `running`; starting the job again (the page's "Continue", or
 * any new request for the same release) adopts it once Cloud Run says the
 * old execution has ended, and resumes from the checkpoint.
 *
 * Inputs. The job takes no argument and no env: the request row (a
 * version), install.json in the ops bucket (which the admin cannot write)
 * and the signed manifest decide everything. All side effects come in
 * through {@link ConvergeJobDeps}, so the run is tested against fakes;
 * converge-job-gcp.ts wires the real ones and `@caelo-cms/platform-updater`
 * the database (`caelo-ops converge-job`).
 */

import type { ConvergeCheckpoint } from "./converge-checkpoint.js";
import {
  CONVERGE_PREFLIGHT_VOICE,
  convergeAccessChecks,
  INSTALL_ROLE_USES,
  selfGrantPlan,
} from "./converge-job-preflight.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import { decideInstallJob, type InstallJobRole } from "./install-job.js";
import type { InstallMetadata } from "./install-state.js";
import {
  adoptClaim,
  type HandoverQueue,
  handOverToRelease,
  isStageOne,
  type JobClaim,
  ownImageProblem,
  type SelfHandoverDeps,
} from "./job-handover.js";
import { provisionerServiceAccountEmail } from "./provisioner-identity.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import { StateLockHeldError } from "./state-store.js";
import type { UpgradeCheckpoint } from "./upgrade/upgrade.js";
import { assessUpgradeRequest } from "./upgrader-assess.js";
import {
  type IamTester,
  missingAccessText,
  preflightErrorReason,
  preflightMissingReason,
  runIamPreflight,
} from "./upgrader-iam-preflight.js";
import {
  recordUpdateEnd,
  type UpdateEnd,
  type UpdateEndStatus,
  type UpdateQueue,
  type UpgraderRunResult,
} from "./upgrader-job.js";
import { type EventReporter, eventReporter, type JobLog } from "./upgrader-reporter.js";

/** What the converge claim found. */
export type ConvergeClaim = JobClaim;

/** The converge job's view of the database (the platform_updater role). */
export interface ConvergeQueue extends Omit<UpdateQueue, "claim">, HandoverQueue {
  /**
   * End runs that died long ago (stale), then return the running converge
   * request, or claim the oldest pending one.
   */
  claimConverge(execution: string | null): Promise<ConvergeClaim | null>;
}

/** How stage 2's upgrade ended (upgrade/upgrade.ts, seen from the job). */
export type ConvergeUpgradeOutcome =
  | {
      readonly ok: true;
      /** Every converge step succeeded and the new contract is recorded. */
      readonly converged: boolean;
    }
  | {
      readonly ok: false;
      /** Traffic went back to the revisions that served before. */
      readonly rolledBack: boolean;
      /** The new release serves but install.json could not record it (#860). */
      readonly unrecorded: boolean;
    };

/**
 * How long stage 2 waits for IAM to confirm the roles it granted itself:
 * Google documents that a policy change usually applies within two minutes
 * and can take seven (cloud.google.com/iam/docs/access-change-propagation).
 */
export const SELF_GRANT_RECHECK_INTERVAL_MS = 15_000;
export const SELF_GRANT_RECHECK_ATTEMPTS = 32;

/** How {@link ConvergeJobDeps.secureDatabase} ended. */
export type SecureDatabaseResult =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly error: string };

export interface ConvergeJobDeps extends SelfHandoverDeps {
  readonly queue: ConvergeQueue;
  /**
   * #1373 — the install's database TLS step (#1338, cloudsql-tls.ts), and
   * then {@link queue} moved onto the database's DNS name with verify-full.
   * Null when the queue already dials that name. Until it ran the queue
   * dials the instance's IP (converge-db-trust.ts), so a failure of the
   * step reaches the timeline and the request's end like any other step;
   * when it fails the queue is reopened on whatever the install dials then.
   */
  readonly secureDatabase: (() => Promise<SecureDatabaseResult>) | null;
  /** From the metadata server — never from env or argv. */
  readonly projectId: string;
  /** The region this job runs in (metadata server). */
  readonly region: string;
  /** Asks IAM as this job's own identity (the IAM self-check, #884). */
  readonly iam: IamTester;
  /**
   * Grant this job's own account (the install's provisioner) `role` on the
   * project. Stage 2 only, and only for roles of the self-grant allowlist
   * (converge-job-preflight.ts); the real one refuses any other role.
   */
  readonly grantOwnRole: (
    role: InstallJobRole,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  /** Waits between the IAM re-checks after a self-grant. */
  readonly sleep: (ms: number) => Promise<void>;
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
  /** install.json as the ops bucket holds it NOW (null when absent) — never cached. */
  readonly readInstall: () => InstallMetadata | null;
  /**
   * Take the install's state lock (#815); returns its release. Throws
   * StateLockHeldError when a live run holds it, any other error when it
   * cannot be taken or judged.
   */
  readonly lockState: (onBreak: (message: string) => void) => () => void;
  readonly readCheckpoint: () => ConvergeCheckpoint | null;
  readonly writeCheckpoint: (checkpoint: ConvergeCheckpoint) => void;
  /** Stage 2: the terminal's upgrade (upgrade/upgrade.ts) to `manifest`, as this account. */
  readonly upgrade: (input: {
    readonly manifest: ReleaseManifest;
    readonly reporter: EventReporter;
    readonly resume: UpgradeCheckpoint | undefined;
    readonly onCheckpoint: (checkpoint: UpgradeCheckpoint) => void;
  }) => Promise<ConvergeUpgradeOutcome>;
  readonly now: () => Date;
  readonly log: JobLog;
}

/** Run the converge job once. Never throws; see the file comment. */
export async function runConvergeJob(deps: ConvergeJobDeps): Promise<UpgraderRunResult> {
  const { queue, log } = deps;
  let claim: ConvergeClaim | null;
  try {
    claim = await queue.claimConverge(deps.execution);
  } catch (e) {
    log({ severity: "ERROR", message: `could not read update requests: ${errorText(e)}` });
    return { exitCode: 1, requestId: null, status: null };
  }
  if (!claim) {
    log({ severity: "INFO", message: "no converge request to run; nothing to do" });
    return { exitCode: 0, requestId: null, status: null };
  }
  const request = claim.request;
  const r = eventReporter(
    (phase, level, message) => queue.event(request.id, phase, level, message),
    log,
    request.id,
  );
  /** This run leaves the request to another (live) run: no end, no events. */
  const leave = (message: string): UpgraderRunResult => {
    log({ severity: "INFO", message, requestId: request.id });
    return { exitCode: 0, requestId: request.id, status: null };
  };
  let releaseLock: (() => void) | null = null;
  const unlock = () => {
    if (!releaseLock) return;
    try {
      releaseLock();
    } catch (e) {
      r.warn(errorText(e));
    }
    releaseLock = null;
  };
  const finish = async (end: UpdateEnd): Promise<UpgraderRunResult> => {
    r.phase("finish");
    if (end.status === "succeeded") r.success(`Caelo ${request.targetVersion} is installed.`);
    else r.error(end.reason ?? end.status);
    await r.flush();
    unlock();
    const recorded = await recordUpdateEnd(queue, request.id, end, log);
    const failed = end.status === "failed" || end.status === "rolled_back" || !recorded;
    return { exitCode: failed ? 1 : 0, requestId: request.id, status: end.status };
  };
  const stopWith = (status: UpdateEndStatus, codes: readonly string[], reason: string) =>
    finish({
      status,
      reason,
      codes,
      pauseAutoUpdates:
        request.trigger === "auto" && (status === "failed" || status === "rolled_back"),
    });

  try {
    const adoption = await adoptClaim(claim, { ...deps, queue });
    if (adoption.kind === "leave") return leave(adoption.message);
    if (adoption.adopted) {
      r.phase("start");
      r.info(
        `Continuing the update to ${request.targetVersion} (run ${deps.execution}; the previous run${claim.execution ? ` ${claim.execution}` : ""} stopped before it finished).`,
      );
    } else if (!claim.resume) {
      r.phase("start");
      r.info(
        `Converge job started${deps.execution ? ` (run ${deps.execution})` : ""}: installing Caelo ${request.targetVersion}, including the changes it makes to this install's cloud setup.`,
      );
    } else {
      r.phase("start");
      r.info(`Caelo ${deps.ownVersion}'s own installer took over (run ${deps.execution}).`);
    }

    // What the install runs — from its own state, never from the admin.
    r.phase("verify");
    const meta = deps.readInstall();
    if (!meta || meta.projectId !== deps.projectId) {
      return stopWith(
        "needs_cloud_shell",
        ["install-state"],
        "The install's records (install.json) are not in its own cloud project, so the converge job cannot tell what it runs. Run the upgrade once from a terminal (Settings → Updates shows how); it moves them there.",
      );
    }
    if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
      return stopWith(
        "refused",
        ["provider"],
        `The converge job only updates Google Cloud installs; this one is ${meta.provider}.`,
      );
    }
    const checkpoint = deps.readCheckpoint();
    const mine = checkpoint !== null && checkpoint.targetVersion === request.targetVersion;
    // An interrupted run may already have recorded the new release in
    // install.json; it is judged from the release it started from.
    const fromVersion =
      mine && checkpoint.state !== "succeeded"
        ? checkpoint.fromVersion
        : (meta.releaseVersion ?? null);
    if (mine && checkpoint.state === "succeeded" && meta.releaseVersion === request.targetVersion) {
      r.info(`An earlier run already finished installing ${request.targetVersion}.`);
      return finish({ status: "succeeded", reason: null, codes: [], pauseAutoUpdates: false });
    }

    const manifestResult = await deps.fetchManifest(request.targetVersion);
    const decision = assessUpgradeRequest({
      request,
      manifest: manifestResult,
      installed: { version: fromVersion, infraContractVersion: meta.infraContractVersion ?? 0 },
      policy: request.policy,
      now: deps.now(),
      route: "converge",
    });
    if (decision.manifest) {
      r.success(
        `Release information of ${decision.manifest.version} verified: signed by Caelo's release workflow.`,
      );
      await queue.record(request.id, {
        manifestSecurity: decision.manifest.security,
        contractMigrations: decision.manifest.migrations.contract,
        infraContractRequired: decision.manifest.infraContractVersion,
        infraContractInstalled: meta.infraContractVersion ?? 0,
        adminDigest: decision.manifest.digests.admin,
        gatewayDigest: decision.manifest.digests.gateway,
        opsDigest: decision.manifest.digests.ops,
      });
    }
    r.phase("assess");
    if (decision.kind === "stop") {
      return stopWith(decision.status, decision.codes, decision.reason);
    }
    for (const w of decision.warnings) r.warn(w);
    const m = decision.manifest;

    // #884 — decided to run: ask IAM for what the rest needs before the
    // lock, the hand-over or the backup (converge-job-preflight.ts). Both
    // stages ask; stage 2's list is the target release's own. A missing
    // role of the self-grant allowlist does not stop the run: stage 2
    // grants it once it has verified its own image and holds the lock.
    const stage1 = isStageOne(deps.ownVersion, m.version);
    const access = await askIam();
    if (access.kind === "error") {
      return stopWith(
        "failed",
        ["iam-preflight"],
        preflightErrorReason(access.errors, CONVERGE_PREFLIGHT_VOICE),
      );
    }
    let toGrant: readonly InstallJobRole[] = [];
    if (access.kind === "missing") {
      const plan = selfGrantPlan(access.missing);
      if (plan.blocking.length > 0) {
        return stopWith(
          "needs_cloud_shell",
          ["iam-preflight"],
          preflightMissingReason(access.missing, CONVERGE_PREFLIGHT_VOICE),
        );
      }
      toGrant = plan.grant;
    }
    if (toGrant.length === 0) {
      r.info("The converge job has every permission this update needs.");
    } else {
      r.info(
        `The converge job's account lacks ${toGrant.join(", ")}, which this update needs. ${stage1 ? `The installer of ${m.version} grants them to it` : "It grants them to itself"} before it changes anything, once its own installer image is verified.`,
      );
    }

    if (stage1) {
      return await handOver(m);
    }
    return await convergeHere(
      m,
      fromVersion ?? (meta.releaseVersion as string),
      checkpoint,
      meta,
      toGrant,
    );
  } catch (e) {
    return stopWith(
      "failed",
      ["internal"],
      `The converge job stopped unexpectedly: ${errorText(e)}. If the site misbehaves, check Settings → Updates and the job's log.`,
    );
  }

  /** Stage 1: hand the request to the target release's own signed installer. */
  async function handOver(m: ReleaseManifest): Promise<UpgraderRunResult> {
    r.info(
      `This installer belongs to Caelo ${deps.ownVersion}; handing over to the installer of ${m.version} itself, so the cloud setup is changed by the release that needs it.`,
    );
    return handOverToRelease(m, {
      deps,
      queue,
      requestId: request.id,
      noun: "installer",
      reporter: r,
      log,
      lock: () => lockOrBlock(false),
      unlock,
      stop: (b) => stopWith(b.status, b.codes, b.reason),
      leave,
    });
  }

  /** Stage 2: this image is the release's own installer; converge + roll. */
  async function convergeHere(
    m: ReleaseManifest,
    fromVersion: string,
    checkpoint: ConvergeCheckpoint | null,
    judged: InstallMetadata,
    toGrant: readonly InstallJobRole[],
  ): Promise<UpgraderRunResult> {
    const installId = judged.installId;
    const wrongImage = ownImageProblem(m, await deps.ownImageDigest(), "installer");
    if (wrongImage) return stopWith(wrongImage.status, wrongImage.codes, wrongImage.reason);
    // The checkpoint's run, if it is not this one, must have ended.
    const live =
      checkpoint && checkpoint.execution !== deps.execution
        ? await deps.executionState(checkpoint.execution)
        : null;
    const decided = decideInstallJob(checkpoint, live);
    if (decided.kind === "attach") {
      return leave(
        `execution ${decided.status.execution} is still converging; this run does nothing`,
      );
    }
    const resumeFrom =
      checkpoint && checkpoint.targetVersion === m.version && checkpoint.state !== "succeeded"
        ? checkpoint
        : null;

    const changed = resumeFrom?.backup !== undefined;
    const locked = lockOrBlock(changed);
    if (locked) return stopWith(locked.status, locked.codes, locked.reason);
    // #815 — everything above was judged against install.json read without
    // the lock; another install operation (the upgrader job, a terminal
    // upgrade) may have changed it since. Never converge on a stale view.
    const stale = recordsChangedSince(judged, changed);
    if (stale) return stopWith(stale.status, stale.codes, stale.reason);

    // After the image check and under the lock: only the target release's
    // verified installer grants, and only roles of its own allowlist.
    if (toGrant.length > 0) {
      const granted = await grantOwnRoles(m, toGrant, changed);
      if (granted) return stopWith(granted.status, granted.codes, granted.reason);
    }

    const startedAt = deps.now().toISOString();
    let current: ConvergeCheckpoint = {
      statusVersion: 1,
      installId,
      execution: deps.execution ?? "local-run",
      state: "running",
      phase: "converge",
      caeloVersion: deps.ownVersion,
      startedAt: resumeFrom?.startedAt ?? startedAt,
      updatedAt: startedAt,
      targetVersion: m.version,
      fromVersion,
      requestId: request.id,
      ...(resumeFrom?.backup ? { backup: resumeFrom.backup } : {}),
      ...(resumeFrom?.priorRevisions ? { priorRevisions: resumeFrom.priorRevisions } : {}),
    };
    const save = (patch: Partial<ConvergeCheckpoint>) => {
      current = { ...current, ...patch, updatedAt: deps.now().toISOString() };
      deps.writeCheckpoint(current);
    };
    // Written before any change: a run killed from here on is resumable.
    save({});

    r.phase("converge");
    // #1373 — stage 2 only, under the lock and after every check: it
    // changes the database instance, its DNS and the services' URLs.
    if (deps.secureDatabase) {
      r.info(
        "Setting up verified encryption for the database connection (the database's certificate and its private DNS name).",
      );
      await r.flush();
      const secured = await deps.secureDatabase();
      if (!secured.ok) {
        save({ state: "failed", phase: "stopped" });
        return stopWith(
          "failed",
          ["database-tls"],
          `The update to ${m.version} stopped at the database's TLS step, before it rolled anything: ${secured.error}. The previous release keeps serving. Fix what it names and start the update again; it continues where it stopped.`,
        );
      }
      r.success(`The database connection is verified (${secured.host}).`);
    }
    const outcome = await deps.upgrade({
      manifest: m,
      reporter: r,
      resume: resumeFrom
        ? {
            ...(resumeFrom.backup ? { backup: resumeFrom.backup } : {}),
            ...(resumeFrom.priorRevisions ? { priorRevisions: resumeFrom.priorRevisions } : {}),
          }
        : undefined,
      onCheckpoint: (c) => {
        if (c.backup) {
          save({ backup: c.backup });
          queue.record(request.id, { backupId: c.backup.backupId }).catch((e: unknown) =>
            log({
              severity: "WARNING",
              message: `could not record the backup id on the request: ${errorText(e)}`,
              requestId: request.id,
            }),
          );
        }
        if (c.priorRevisions) save({ priorRevisions: { ...c.priorRevisions } });
      },
    });

    if (outcome.ok) {
      save({ state: "succeeded", phase: "Done" });
      if (!outcome.converged) {
        r.warn(
          "The new release serves, but some cloud-setup steps did not finish (see above); the next update repeats them.",
        );
      }
      return finish({ status: "succeeded", reason: null, codes: [], pauseAutoUpdates: false });
    }
    save({ state: "failed", phase: outcome.rolledBack ? "rolled back" : "stopped" });
    if (outcome.unrecorded) {
      return stopWith(
        "failed",
        ["record"],
        `Caelo ${m.version} serves and passed its checks, but the install's records (install.json) could not be updated, so they still name the previous release. Start the update again from Settings → Updates; it records them.`,
      );
    }
    if (outcome.rolledBack) {
      return stopWith(
        "rolled_back",
        ["health"],
        `Caelo ${m.version} did not pass its checks, so the previous release serves again. The timeline above says which step failed.`,
      );
    }
    return stopWith(
      "failed",
      ["converge"],
      `The update to ${m.version} stopped before it finished (see the timeline above); the previous release keeps serving. Fix what it names and start the update again; it continues where it stopped.`,
    );
  }

  /** The converge self-check against IAM, as this job's identity. */
  function askIam() {
    return runIamPreflight(
      convergeAccessChecks({ projectId: deps.projectId, region: deps.region, env: GCP_STACK_ENV }),
      deps.iam,
    );
  }

  /**
   * Stage 2: grant this job's account each role in `roles` (the self-check
   * found them missing; all are on the allowlist), then wait until IAM
   * confirms the whole self-check. Null when it does; how the request ends
   * otherwise.
   */
  async function grantOwnRoles(
    m: ReleaseManifest,
    roles: readonly InstallJobRole[],
    changed: boolean,
  ): Promise<{ status: UpdateEndStatus; codes: string[]; reason: string } | null> {
    const account = provisionerServiceAccountEmail(deps.projectId);
    const granted: InstallJobRole[] = [];
    const before = () =>
      changed
        ? "This update already started changing the site; "
        : granted.length > 0
          ? `Nothing on the site was changed (the converge job's account got ${granted.join(", ")}): `
          : "Nothing was changed: ";
    for (const role of roles) {
      const result = await deps.grantOwnRole(role);
      if (!result.ok) {
        return {
          status: "needs_cloud_shell",
          codes: ["iam-self-grant"],
          reason: `${before()}the converge job could not grant its own account (${account}) ${role}, which Caelo ${m.version} needs to ${INSTALL_ROLE_USES[role].need} (${result.error}). ${CONVERGE_PREFLIGHT_VOICE.repair}`,
        };
      }
      granted.push(role);
      r.success(
        `Granted ${role} to the converge job's account (${account}), needed by Caelo ${m.version} to ${INSTALL_ROLE_USES[role].need}.`,
      );
    }
    await r.flush();
    let last = await askIam();
    for (let attempt = 1; last.kind !== "ok" && attempt < SELF_GRANT_RECHECK_ATTEMPTS; attempt++) {
      await deps.sleep(SELF_GRANT_RECHECK_INTERVAL_MS);
      last = await askIam();
    }
    if (last.kind === "ok") {
      r.info(
        "IAM confirms the granted roles; the converge job has every permission this update needs.",
      );
      return null;
    }
    const minutes = Math.round(
      (SELF_GRANT_RECHECK_INTERVAL_MS * (SELF_GRANT_RECHECK_ATTEMPTS - 1)) / 60_000,
    );
    if (last.kind === "error") {
      return {
        status: "failed",
        codes: ["iam-self-grant"],
        reason: `${before()}after granting its own account ${granted.join(", ")}, the converge job could not check its access again (${last.errors.join("; ")}). Start the update again from Settings → Updates in a few minutes.`,
      };
    }
    return {
      status: "needs_cloud_shell",
      codes: ["iam-self-grant"],
      reason: `${before()}the converge job granted its own account ${granted.join(", ")}, but ${minutes} minutes later Google Cloud still reports permissions missing — ${missingAccessText(last.missing)}. ${CONVERGE_PREFLIGHT_VOICE.repair}`,
    };
  }

  /**
   * Whether install.json, re-read under the lock, is still what the run was
   * judged on; how the request ends otherwise.
   */
  function recordsChangedSince(
    judged: InstallMetadata,
    changed: boolean,
  ): { status: UpdateEndStatus; codes: string[]; reason: string } | null {
    const before = changed
      ? "This update already started changing the site; "
      : "Nothing was changed: ";
    let now: InstallMetadata | null;
    try {
      now = deps.readInstall();
    } catch (e) {
      return {
        status: "failed",
        codes: ["install-state-read"],
        reason: `${before}the install's records (install.json) could not be read again once the lock was held (${errorText(e)}). Start the update again; it continues where it stopped.`,
      };
    }
    if (JSON.stringify(now) === JSON.stringify(judged)) return null;
    return {
      status: "failed",
      codes: ["install-state-changed"],
      reason: `${before}another install operation changed the install's records (install.json) while this update was being checked. Start the update again from Settings → Updates; it continues where it stopped.`,
    };
  }

  /**
   * Take the state lock, or say how the request ends instead. `changed`:
   * an earlier run of this update already changed something.
   */
  function lockOrBlock(
    changed: boolean,
  ): { status: UpdateEndStatus; codes: string[]; reason: string } | null {
    const before = changed
      ? "This update already started changing the site; "
      : "Nothing was changed: ";
    try {
      releaseLock = deps.lockState((message) => r.info(message));
      return null;
    } catch (e) {
      if (e instanceof StateLockHeldError) {
        return {
          status: "failed",
          codes: ["state-locked"],
          reason: `${before}another install operation is running on this site (${errorText(e)}). Start the update again when it has finished; it continues where it stopped.`,
        };
      }
      return {
        status: "needs_cloud_shell",
        codes: ["state-access"],
        reason: `${before}the converge job could not take the install's state lock (${errorText(e)}). Run the upgrade once from a terminal (Settings → Updates shows how); it repairs the job's access.`,
      };
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
