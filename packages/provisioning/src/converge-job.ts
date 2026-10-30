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
 *     it; then it checks its own IAM access (converge-job-preflight.ts).
 *     Then it verifies the target's ops image, points this job at it BY DIGEST and starts a new
 *     execution, handing the request over to it. It changes nothing else:
 *     the converge logic always comes from the release it installs.
 *
 *   Stage 2 — the job runs the TARGET release's ops image (its own
 *     version is the request's). It verifies the manifest again, checks
 *     that the image it runs is the one the manifest signs, takes the
 *     install's state lock (#815; the upgrader job and the terminal
 *     `upgrade` take the same one, so they exclude each other), and runs
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
import { CONVERGE_PREFLIGHT_VOICE, convergeAccessChecks } from "./converge-job-preflight.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import { decideInstallJob, type ExecutionState } from "./install-job.js";
import type { InstallMetadata } from "./install-state.js";
import {
  compareSemver,
  type ReleaseManifest,
  type ReleaseManifestResult,
} from "./release-manifest.js";
import { StateLockHeldError } from "./state-store.js";
import type { UpgradeCheckpoint } from "./upgrade/upgrade.js";
import { assessUpgradeRequest } from "./upgrader-assess.js";
import {
  type IamTester,
  preflightErrorReason,
  preflightMissingReason,
  runIamPreflight,
} from "./upgrader-iam-preflight.js";
import {
  type ClaimedUpdate,
  recordUpdateEnd,
  type UpdateEnd,
  type UpdateEndStatus,
  type UpdateQueue,
  type UpgraderRunResult,
} from "./upgrader-job.js";
import { type EventReporter, eventReporter, type JobLog } from "./upgrader-reporter.js";

/** What the converge claim found. */
export interface ConvergeClaim {
  readonly request: ClaimedUpdate;
  /**
   * The request was already running: stage 1 handed it to this run, or a
   * run that died left it. Fresh claims (pending → running) are false.
   */
  readonly resume: boolean;
  /** The execution the request names now (after a fresh claim: this one). */
  readonly execution: string | null;
}

/** The converge job's view of the database (the platform_updater role). */
export interface ConvergeQueue extends Omit<UpdateQueue, "claim"> {
  /**
   * End runs that died long ago (stale), then return the running converge
   * request, or claim the oldest pending one.
   */
  claimConverge(execution: string | null): Promise<ConvergeClaim | null>;
  /**
   * Point running request `requestId` at execution `to` — or at none
   * (`null`: released for the next run to adopt) — only while it still
   * names `from`. Resolves false when another run got there first.
   */
  handover(requestId: string, from: string | null, to: string | null): Promise<boolean>;
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

export interface ConvergeJobDeps {
  readonly queue: ConvergeQueue;
  /** From the metadata server — never from env or argv. */
  readonly projectId: string;
  /** The region this job runs in (metadata server). */
  readonly region: string;
  /** Asks IAM as this job's own identity (the IAM self-check, #884). */
  readonly iam: IamTester;
  /** This Cloud Run execution; null outside Cloud Run. */
  readonly execution: string | null;
  /** The Caelo release this code belongs to (CAELO_VERSION of the image). */
  readonly ownVersion: string;
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
  /** install.json as the ops bucket holds it NOW (null when absent) — never cached. */
  readonly readInstall: () => InstallMetadata | null;
  /** Verify the cosign signature of the release image `slug@digest`. */
  readonly verifyImage: (slug: "ops", digest: string) => Promise<boolean>;
  /** The digest of the image this execution runs (from Cloud Run); null when unreadable. */
  readonly ownImageDigest: () => Promise<string | null>;
  /** Point this job at the ops image with `digest` (its identity, command and args stay). */
  readonly pointJobAt: (
    digest: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  /** Start a new execution of this job; returns its name. */
  readonly startJob: () => Promise<
    | { readonly ok: true; readonly execution: string }
    | { readonly ok: false; readonly error: string }
  >;
  /** Where an execution of this job stands (Cloud Run). */
  readonly executionState: (execution: string) => Promise<ExecutionState>;
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
    // A request another execution started: adopt it only once that one
    // has ended — two converges at once must never happen.
    if (claim.resume && claim.execution !== deps.execution) {
      if (!deps.execution) {
        return leave("a converge request is running; only a Cloud Run execution may adopt it");
      }
      if (claim.execution) {
        const live = await deps.executionState(claim.execution);
        if (live === "running") {
          return leave(`execution ${claim.execution} is still installing; this run does nothing`);
        }
      }
      if (!(await queue.handover(request.id, claim.execution, deps.execution))) {
        return leave("another run adopted the request first; this run does nothing");
      }
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
    // stages ask; stage 2's list is the target release's own.
    const access = await runIamPreflight(
      convergeAccessChecks({ projectId: deps.projectId, region: deps.region, env: GCP_STACK_ENV }),
      deps.iam,
    );
    if (access.kind === "missing") {
      return stopWith(
        "needs_cloud_shell",
        ["iam-preflight"],
        preflightMissingReason(access.missing, CONVERGE_PREFLIGHT_VOICE),
      );
    }
    if (access.kind === "error") {
      return stopWith(
        "failed",
        ["iam-preflight"],
        preflightErrorReason(access.errors, CONVERGE_PREFLIGHT_VOICE),
      );
    }
    r.info("The converge job has every permission this update needs.");

    if (compareSemver(deps.ownVersion, m.version) !== 0) {
      return await handOver(m);
    }
    return await convergeHere(m, fromVersion ?? (meta.releaseVersion as string), checkpoint, meta);
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
    if (!(await deps.verifyImage("ops", m.digests.ops))) {
      return stopWith(
        "refused",
        ["signature"],
        `The installer image of ${m.version} is not signed by Caelo's release workflow, so nothing was changed.`,
      );
    }
    // Under the lock (the terminal `upgrade` redeploys this job too), and
    // released before the new run starts: it takes the lock itself.
    const locked = lockOrBlock(false);
    if (locked) return stopWith(locked.status, locked.codes, locked.reason);
    const pointed = await deps.pointJobAt(m.digests.ops);
    unlock();
    if (!pointed.ok) {
      return stopWith(
        "failed",
        ["handover"],
        `Nothing was changed: the installer of ${m.version} could not be prepared (${pointed.error}). Try again in a moment.`,
      );
    }
    // Release the request BEFORE the new run exists: it adopts a request
    // that names no run at once, while a run still named (this one, alive
    // for a moment longer) would make it step back.
    if (!(await queue.handover(request.id, deps.execution, null))) {
      return leave("the request moved on before the hand-over; this run does nothing");
    }
    const started = await deps.startJob();
    if (!started.ok) {
      return stopWith(
        "failed",
        ["handover"],
        `Nothing was changed: the installer of ${m.version} could not be started (${started.error}). Try again in a moment.`,
      );
    }
    r.info(`The installer of ${m.version} runs now (run ${started.execution}).`);
    await r.flush();
    log({
      severity: "INFO",
      message: `handed over to ${started.execution}`,
      requestId: request.id,
    });
    return { exitCode: 0, requestId: request.id, status: null };
  }

  /** Stage 2: this image is the release's own installer; converge + roll. */
  async function convergeHere(
    m: ReleaseManifest,
    fromVersion: string,
    checkpoint: ConvergeCheckpoint | null,
    judged: InstallMetadata,
  ): Promise<UpgraderRunResult> {
    const installId = judged.installId;
    const own = await deps.ownImageDigest();
    // Cloud Run records the linux/amd64 platform manifest it resolved, not
    // the index the hand-over pinned (#1025), so an execution of the right
    // image reads back as the platform form the manifest also signs.
    const signedForms = [m.digests.ops, ...(m.platformDigests ? [m.platformDigests.ops] : [])];
    if (own === null || !signedForms.includes(own)) {
      return stopWith(
        "refused",
        ["ops-image"],
        `Nothing was changed: this run's installer image (${own ?? "unknown"}) is not the one Caelo's release workflow signed for ${m.version} (${signedForms.join(" or ")}). Start the update again from Settings → Updates.`,
      );
    }
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
