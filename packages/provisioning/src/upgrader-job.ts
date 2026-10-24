// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job (epic #696 Phase 2): installs one signed Caelo release
 * on a `gcp` / `gcp-firebase` install, from inside the install's own cloud.
 *
 * The admin's "Install update" writes a `platform_update_requests` row and
 * starts this job. The admin holds only `run.jobs.run` on it — not
 * `runWithOverrides` — so it cannot pass arguments, env or another image
 * (upgrader-setup.ts). The job runs as its own service account, which may
 * deploy Cloud Run revisions, run the migration job and back up Cloud SQL,
 * but cannot change IAM, service accounts or secrets. One run:
 *
 *   1. claim the oldest pending request (ending a run that died mid-way);
 *   2. read what the install runs from install.json in its ops bucket; when
 *      it names other images than the ones serving, judge against the
 *      serving release if a signed release manifest names both its images,
 *      else stop (upgrader-records.ts, #860);
 *   3. fetch the release manifest from the FIXED registry and verify its
 *      signature (release-manifest.ts) — no registry, identity or digest
 *      ever comes from the request, the env or argv;
 *   4. decide (upgrader-assess.ts): refuse a bad signature, a downgrade, a
 *      release below its minFromVersion, an automatic run the policy does
 *      not allow; hand an infrastructure change back (the admin routes
 *      it to the converge job, #819; Cloud Shell on installs without one);
 *   -- ask IAM whether the job's account holds every permission the rest
 *      of the run needs (upgrader-iam-preflight.ts, #818); any missing one
 *      ends the run as needs-Cloud-Shell, all of them named, nothing changed;
 *   -- only now take the install's state lock (#815), confirm install.json
 *      is unchanged since step 2, and write step 2's correction. Everything
 *      above only reads, so no lock problem can hide the verdict; a stop
 *      verdict still corrects the records when the lock is free. Only a
 *      verdict judged on drift asks for the lock even when it stops: the
 *      serving images were read without it, and a run that holds it may be
 *      half-way through its own roll — then the answer is "another install
 *      operation is running", never a drift or Cloud Shell verdict;
 *   5. take a Cloud SQL backup — no backup, no change;
 *   6. app-roll (upgrade/app-roll.ts) with no converge hooks: migrations
 *      with the new admin image, admin then gateway, deep health check,
 *      traffic back onto the previous revisions on any failure;
 *   7. record the new digests + version in install.json (a failed write
 *      ends the run as failed, never as succeeded);
 *   8. move this job onto the release's own ops image, last.
 *
 * Every step is narrated into `platform_update_events` (upgrader-reporter.ts).
 * All side effects come in through {@link UpgraderJobDeps}, so the whole
 * run is tested against fakes; the real wiring is the
 * `@caelo-cms/platform-updater` package (`caelo-ops upgrader`).
 */

import type {
  AutoUpdateBasis,
  PlatformUpdateEventLevel,
  PlatformUpdatePhase,
  PlatformUpdateTrigger,
  StoredUpdatePolicy,
} from "@caelo-cms/shared";
import type { GcloudRunner, Sleep } from "./gcloud-retry.js";
import { gcpNamePrefix, upgraderJobName } from "./gcp-names.js";
import type { InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import { StateLockHeldError } from "./state-store.js";
import {
  type AppRollPlan,
  executeAppRoll,
  planAppRoll,
  type ReleaseImage,
  type RollSlug,
} from "./upgrade/app-roll.js";
import { restoreCommand, takeSqlBackup } from "./upgrade/backup.js";
import {
  findServingImage,
  findTemplateImageDigest,
  lookupFailure,
  resolveGcpResourceName,
  servingImageDigests,
} from "./upgrade/gcp-lookup.js";
import type { HealthProbe } from "./upgrade/health.js";
import { platformDigestsOf, type ReleaseImageForms } from "./upgrade/image-forms.js";
import { releaseImageRef } from "./upgrade/release-images.js";
import { assessUpgradeRequest, type RefusalCode } from "./upgrader-assess.js";
import {
  type IamTester,
  preflightErrorReason,
  preflightMissingReason,
  runIamPreflight,
  UPGRADER_PREFLIGHT_VOICE,
  upgraderAccessChecks,
} from "./upgrader-iam-preflight.js";
import {
  findServingRelease,
  recordMatchesServing,
  type ServingDigests,
} from "./upgrader-records.js";
import { eventReporter, type JobLog } from "./upgrader-reporter.js";

/** A request the job claimed, with the policy as it stood at claim time. */
export interface ClaimedUpdate {
  readonly id: string;
  readonly targetVersion: string;
  readonly trigger: PlatformUpdateTrigger;
  /** Why the admin's scheduler queued an automatic request; null for the Owner's. */
  readonly autoBasis?: AutoUpdateBasis | null;
  readonly policy: StoredUpdatePolicy;
}

/** Facts the job learns and stores on the request for the admin to show. */
export interface UpdateFacts {
  readonly manifestSecurity?: boolean;
  readonly contractMigrations?: boolean;
  readonly infraContractRequired?: number;
  readonly infraContractInstalled?: number;
  readonly adminDigest?: string;
  readonly gatewayDigest?: string;
  readonly opsDigest?: string;
  readonly backupId?: string;
}

/** How a request ended. */
export type UpdateEndStatus =
  | "succeeded"
  | "rolled_back"
  | "failed"
  | "refused"
  | "needs_cloud_shell";

export interface UpdateEnd {
  readonly status: UpdateEndStatus;
  readonly reason: string | null;
  readonly codes: readonly string[];
  /** A failed automatic install pauses automatic installs (Phase 5). */
  readonly pauseAutoUpdates: boolean;
}

/** The job's view of the database (the platform_updater role, via the Query API). */
export interface UpdateQueue {
  /** End a run that died mid-way, then claim the oldest pending request. */
  claim(execution: string | null): Promise<ClaimedUpdate | null>;
  event(
    requestId: string,
    phase: PlatformUpdatePhase,
    level: PlatformUpdateEventLevel,
    message: string,
  ): Promise<void>;
  record(requestId: string, facts: UpdateFacts): Promise<void>;
  /**
   * End a running request. Resolves false when it was no longer running
   * (another process already ended it), so nothing changed.
   */
  finish(requestId: string, end: UpdateEnd): Promise<boolean>;
}

export interface UpgraderJobDeps {
  readonly queue: UpdateQueue;
  readonly run: GcloudRunner;
  readonly sleep?: Sleep;
  /** From the metadata server — never from env or argv. */
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** This Cloud Run execution, for the log link; null outside Cloud Run. */
  readonly execution: string | null;
  /**
   * Asks IAM which permissions the job's own account holds (#818), for the
   * self-check right after the decision. Never the action itself.
   */
  readonly iam: IamTester;
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
  /**
   * Every digest a release image is known by (#1025): the signed platform
   * digests, else the content-checked index from the fixed mirror
   * (createReleaseImageForms). One instance per run, so each index is read
   * at most once.
   */
  readonly imageForms: ReleaseImageForms;
  /**
   * Take the install's state lock (the one `pulumi up`, `state migrate` and
   * the CLI `upgrade` hold) right before the run's first write; returns its
   * release. Breaks a lock whose holder has ended and reports that through
   * `onBreak` (state-store.ts). Throws StateLockHeldError when a live run
   * holds it, any other error when it cannot be taken or judged.
   */
  readonly lockState: (onBreak: (message: string) => void) => () => void;
  /** install.json as the ops bucket holds it NOW (null when absent) — never cached. */
  readonly readInstall: () => InstallMetadata | null;
  readonly writeInstall: (meta: InstallMetadata) => void;
  /** Runs both migration targets with the NEW admin image. */
  readonly migrate: (
    imageRef: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly healthProbe: (
    plan: AppRollPlan,
  ) => Promise<
    | { readonly ok: true; readonly probe: HealthProbe }
    | { readonly ok: false; readonly error: string }
  >;
  readonly now: () => Date;
  readonly log: JobLog;
}

/** What one run did: the exit code, and the request it handled (if any). */
export interface UpgraderRunResult {
  readonly exitCode: number;
  readonly requestId: string | null;
  readonly status: UpdateEndStatus | null;
}

/** Why the run cannot go on: how its request ends. */
interface Blocked {
  readonly status: UpdateEndStatus;
  readonly codes: readonly string[];
  readonly reason: string;
}

type LockOutcome = { readonly ok: true } | ({ readonly ok: false } & Blocked);

const ROLLED_PHASES = new Set(["roll", "health"]);

/**
 * Lock outcomes that mean another run is changing the install right now
 * (#815): a verdict judged from serving images read without the lock may
 * describe that run's half-finished roll, so it is not reported.
 */
const STALE_VERDICT: ReadonlySet<string> = new Set(["state-locked", "install-state-changed"]);

/** Attempts at recording a request's end state before the run fails. */
const FINISH_ATTEMPTS = 3;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the job once. Never throws; see the file comment for the sequence. */
export async function runUpgraderJob(deps: UpgraderJobDeps): Promise<UpgraderRunResult> {
  const { queue, log } = deps;
  let claimed: ClaimedUpdate | null;
  try {
    claimed = await queue.claim(deps.execution);
  } catch (e) {
    log({ severity: "ERROR", message: `could not read update requests: ${errorText(e)}` });
    return { exitCode: 1, requestId: null, status: null };
  }
  if (!claimed) {
    log({ severity: "INFO", message: "no pending update request; nothing to do" });
    return { exitCode: 0, requestId: null, status: null };
  }
  const request = claimed;
  const r = eventReporter(
    (phase, level, message) => queue.event(request.id, phase, level, message),
    log,
    request.id,
  );
  let releaseLock: (() => void) | null = null;
  const finish = async (end: UpdateEnd): Promise<UpgraderRunResult> => {
    r.phase("finish");
    if (end.status === "succeeded") r.success(`Caelo ${request.targetVersion} is installed.`);
    else r.error(end.reason ?? end.status);
    await r.flush();
    if (releaseLock) {
      try {
        releaseLock();
      } catch (e) {
        r.warn(errorText(e));
      }
      releaseLock = null;
    }
    const recorded = await recordUpdateEnd(queue, request.id, end, log, deps.sleep);
    const failed = end.status === "failed" || end.status === "rolled_back" || !recorded;
    return { exitCode: failed ? 1 : 0, requestId: request.id, status: end.status };
  };
  const stopWith = (
    status: UpdateEndStatus,
    codes: readonly (RefusalCode | string)[],
    reason: string,
  ) =>
    finish({
      status,
      reason,
      codes,
      pauseAutoUpdates:
        request.trigger === "auto" && (status === "failed" || status === "rolled_back"),
    });

  try {
    r.phase("start");
    r.info(
      `Upgrader started${deps.execution ? ` (run ${deps.execution})` : ""}: installing Caelo ${request.targetVersion}.`,
    );

    // #815 — the state lock is taken only right before the first write
    // (lockBeforeWrite below), never before the decision: any lock problem
    // must not hide the verdict (needs Cloud Shell, refused), and a run
    // that changes nothing has no business blocking another.
    const lockBeforeWrite = (): LockOutcome => {
      try {
        releaseLock = deps.lockState((message) => r.info(message));
        return { ok: true };
      } catch (e) {
        if (e instanceof StateLockHeldError) {
          return {
            ok: false,
            status: "failed",
            codes: ["state-locked"],
            reason: `Nothing was changed: another install operation is running on this site (${errorText(e)}). Try again when it has finished.`,
          };
        }
        // Not contention: the job cannot reach its own ops bucket or ask
        // Cloud Run about the holder. Retrying will not help; a Cloud Shell
        // upgrade re-converges the job's grants.
        return {
          ok: false,
          status: "needs_cloud_shell",
          codes: ["state-access"],
          reason: `Nothing was changed: the upgrader could not take the install's state lock (${errorText(e)}). Run the upgrade once with Cloud Shell; it repairs the upgrader's access.`,
        };
      }
    };

    // 2. What the install runs — from its own state, never from the admin.
    r.phase("verify");
    const read = deps.readInstall();
    if (!read || read.projectId !== deps.projectId) {
      return stopWith(
        "needs_cloud_shell",
        ["install-state"],
        "The install's records (install.json) are not in its own cloud project yet, so the upgrader cannot tell what it runs. Run the upgrade once with Cloud Shell; it moves them there.",
      );
    }
    if (read.provider !== "gcp" && read.provider !== "gcp-firebase") {
      return stopWith(
        "refused",
        ["provider"],
        `The upgrader job only upgrades Google Cloud installs; this one is ${read.provider}.`,
      );
    }
    // Rebound when the records are refreshed below; `provider` is narrowed.
    let meta: InstallMetadata & { provider: "gcp" | "gcp-firebase" } = {
      ...read,
      provider: read.provider,
    };
    /** The corrected records (#860), when install.json is stale; written under the lock. */
    let heal: InstallMetadata | null = null;

    /**
     * Take the lock, confirm install.json is still what was judged, and
     * write the pending correction. Returns null when all of that held.
     */
    const lockAndHeal = (): Blocked | null => {
      const locked = lockBeforeWrite();
      if (!locked.ok) return locked;
      // Another writer may have changed the records between our read and
      // the lock; everything above was judged against the old ones.
      // A failed re-read is a Blocked like any other, never a throw: on the
      // stop-verdict path a throw here would replace the verdict with
      // failed/internal.
      let now: InstallMetadata | null;
      try {
        now = deps.readInstall();
      } catch (e) {
        return {
          status: "failed",
          codes: ["install-state-read"],
          reason: `Nothing was changed: the install's records (install.json) could not be read again once the lock was held (${errorText(e)}). Try again.`,
        };
      }
      if (JSON.stringify(now) !== JSON.stringify(read)) {
        return {
          status: "failed",
          codes: ["install-state-changed"],
          reason:
            "Nothing was changed: another install operation changed the install's records (install.json) while this update was being checked. Try again.",
        };
      }
      if (!heal) return null;
      const v = heal.releaseVersion;
      try {
        deps.writeInstall(heal);
      } catch (e) {
        return {
          status: "failed",
          codes: ["install-state-write"],
          reason: `Nothing was changed: the install's records (install.json) name another release than the one that serves (v${v}), and they could not be corrected (${errorText(e)}).`,
        };
      }
      r.success(`Caelo refreshed its install records: v${v} serves.`);
      return null;
    };

    // install.json must describe what actually serves: if a previous run
    // rolled but could not record it, the recorded version is stale and
    // the downgrade / minFromVersion checks would judge against it.
    const serving = await servingDigests(deps);
    if (!serving.ok) {
      return stopWith("failed", ["lookup"], `Nothing was changed: ${serving.error}.`);
    }
    if (!recordMatchesServing(meta, serving.digests)) {
      // #860 — re-record the serving release ourselves, but only one whose
      // admin AND gateway images a signed release manifest names, as its
      // index or a platform manifest inside it (#1025).
      const found = await findServingRelease(meta, serving.digests, {
        run: deps.run,
        fetchManifest: deps.fetchManifest,
        imageForms: deps.imageForms,
        hintDigests: () => templateDigests(deps, serving.services),
      });
      if (!found.ok) {
        if (found.retryable) return stopWith("failed", ["registry"], found.reason);
        // #815 — the serving images were read without the lock: a run that
        // holds it may be half-way through its roll, and that is not drift.
        // Only once this run holds the lock (or cannot take it at all) is
        // the mismatch the install's real state.
        const blocked = lockAndHeal();
        if (blocked && STALE_VERDICT.has(blocked.codes[0] ?? "")) {
          return stopWith(blocked.status, blocked.codes, blocked.reason);
        }
        return stopWith("needs_cloud_shell", ["install-state-drift"], found.reason);
      }
      // The manifest's index digests, not the serving ones: the signed form
      // is the one every deploy pins. The linux/amd64 forms go next to them
      // (#1025), so the next run matches what Cloud Run records directly.
      const { platformDigests: _stale, ...rest } = meta;
      meta = {
        ...rest,
        imageDigests: {
          admin: found.manifest.digests.admin,
          gateway: found.manifest.digests.gateway,
        },
        ...(found.platformDigests ? { platformDigests: found.platformDigests } : {}),
        releaseVersion: found.manifest.version,
      };
      // Judged against now, written under the lock once decided (#815).
      heal = meta;
    }

    // 3 + 4. The signed manifest decides.
    const manifest = await deps.fetchManifest(request.targetVersion);
    const decision = assessUpgradeRequest({
      request,
      manifest,
      installed: {
        version: meta.releaseVersion ?? null,
        infraContractVersion: meta.infraContractVersion ?? 0,
      },
      policy: request.policy,
      now: deps.now(),
    });
    const verified = decision.manifest;
    if (verified) {
      r.success(
        `Release information of ${verified.version} verified: signed by Caelo's release workflow.`,
      );
      await recordFacts(queue, request.id, verified, meta);
    }
    if (decision.kind === "stop") {
      r.phase("assess");
      if (heal) {
        // The records still get corrected, but the verdict is the answer:
        // a lock or write problem here must not replace it (#815).
        // Except when another run holds the lock or changed the records:
        // then the drift this verdict was judged on may be that run's
        // half-finished work, and "try again once it has finished" is the
        // true answer.
        const blocked = lockAndHeal();
        if (blocked && STALE_VERDICT.has(blocked.codes[0] ?? "")) {
          return stopWith(blocked.status, blocked.codes, blocked.reason);
        }
        if (blocked) {
          r.warn(`The install's records could not be corrected this time: ${blocked.reason}`);
        }
      }
      return stopWith(decision.status, decision.codes, decision.reason);
    }
    r.phase("assess");
    for (const w of decision.warnings) r.warn(w);
    r.info(
      `${meta.releaseVersion} → ${decision.manifest.version}: no cloud-setup change needed; installing.`,
    );

    // #818 — decided to run: ask IAM for every permission the rest needs
    // before the lock, the backup or the roll. A grant that looks right but
    // cannot match (#799) ends the run here, all of them named, not halfway.
    const access = await runIamPreflight(
      upgraderAccessChecks({ projectId: deps.projectId, region: deps.region, env: deps.env }),
      deps.iam,
    );
    if (access.kind === "missing") {
      return stopWith(
        "needs_cloud_shell",
        ["iam-preflight"],
        preflightMissingReason(access.missing, UPGRADER_PREFLIGHT_VOICE),
      );
    }
    if (access.kind === "error") {
      return stopWith(
        "failed",
        ["iam-preflight"],
        preflightErrorReason(access.errors, UPGRADER_PREFLIGHT_VOICE),
      );
    }
    r.info("The upgrader has every permission this update needs.");

    const m = decision.manifest;
    const images: Record<RollSlug, ReleaseImage> = {
      admin: { digest: m.digests.admin, imageRef: releaseImageRef("admin", m.digests.admin) },
      gateway: {
        digest: m.digests.gateway,
        imageRef: releaseImageRef("gateway", m.digests.gateway),
      },
    };
    const planned = await planAppRoll(
      {
        provider: meta.provider,
        projectId: deps.projectId,
        region: deps.region,
        env: deps.env,
        domain: meta.domain,
        stagingHost: meta.stagingDomain ?? `staging.${meta.domain}`,
        credentials: "job",
      },
      images,
      deps.run,
      // Holds no Secret Manager permission (upgrader-setup.ts); the
      // converge — operator or converge job — runs the #954 volume check.
      { secretVolumes: false },
    );
    if (!planned.ok) {
      return stopWith("failed", ["plan"], `Nothing was changed: ${planned.error}.`);
    }
    for (const w of planned.plan.warnings) r.warn(w);

    // Decided, planned: the backup (or the records correction) is the first
    // write. Held through the roll, install.json and the self-update.
    const blocked = lockAndHeal();
    if (blocked) return stopWith(blocked.status, blocked.codes, blocked.reason);

    // 5. No backup, no change.
    r.phase("backup");
    const sBak = r.step("Backing up the database before anything changes...");
    const backup = await takeSqlBackup(
      deps.run,
      { projectId: deps.projectId, env: deps.env, credentials: "job" },
      `pre-upgrade to ${m.version}`,
      deps.now,
    );
    if (!backup.ok) {
      sBak.failed(`Backup failed: ${backup.error}`);
      return stopWith(
        "failed",
        ["backup"],
        `The pre-upgrade database backup failed, so nothing was changed (${backup.error}). Try again later.`,
      );
    }
    sBak.done(`Backup ${backup.backup.backupId} taken.`);
    await queue.record(request.id, { backupId: backup.backup.backupId });

    const probe = await deps.healthProbe(planned.plan);
    if (!probe.ok) {
      return stopWith(
        "failed",
        ["health-check"],
        `The health check could not be prepared, so nothing was changed: ${probe.error}`,
      );
    }

    // 6 + 7. The roll; it rolls back by itself on failure.
    let recordError: string | null = null;
    const rolled = await executeAppRoll(
      {
        plan: planned.plan,
        backup: backup.backup,
        targetVersion: m.version,
        migrationsContract: m.migrations.contract,
      },
      {},
      {
        run: deps.run,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        reporter: r,
        migrate: deps.migrate,
        health: probe.probe,
        // The roll already succeeded, so a failed write must not undo it;
        // it is held here and ends the run as failed below (no fallbacks:
        // never "succeeded" while the records name the previous release).
        recordDigests: async (digests) => {
          r.phase("record");
          // #1025 — both forms, so the next run recognises what Cloud Run
          // records without a registry lookup. Not knowing the platform form
          // is no failure: the next run then reads the index itself.
          const platform = await platformDigestsOf(digests, deps.imageForms, m);
          if (!platform.ok) {
            r.warn(
              `install.json records ${m.version} by its image indexes only; their linux/amd64 forms could not be read (${platform.message}). The next update reads them from the release registry.`,
            );
          }
          try {
            const { platformDigests: _previous, ...fresh } = deps.readInstall() ?? meta;
            deps.writeInstall({
              ...fresh,
              imageDigests: digests,
              ...(platform.ok ? { platformDigests: platform.platformDigests } : {}),
              releaseVersion: m.version,
            });
            r.info(`Recorded ${m.version} as this install's release.`);
          } catch (e) {
            recordError = errorText(e);
            r.error(
              `The new release serves, but install.json could not be updated (${recordError}).`,
            );
          }
        },
      },
    );
    if (!rolled.ok) {
      const restore = rolled.migrated
        ? ` The database backup ${backup.backup.backupId} is there if you need it (${restoreCommand(backup.backup)}).`
        : "";
      if (ROLLED_PHASES.has(rolled.phase)) {
        return stopWith(
          "rolled_back",
          [rolled.phase],
          `Caelo ${m.version} did not pass its checks, so the previous release serves again.${restore}`,
        );
      }
      return stopWith(
        "failed",
        [rolled.phase],
        `Stopped during ${rolled.phase === "migrations" ? "the database migrations" : "the pre-check"}; the previous release keeps serving.${restore}`,
      );
    }
    if (recordError !== null) {
      return stopWith(
        "failed",
        ["record"],
        `Caelo ${m.version} serves and passed its checks, but the install's records (install.json) could not be updated (${recordError}), so they still name the previous release. The next update corrects them by itself once the upgrader can write its ops bucket again; check the upgrader's access to it.`,
      );
    }

    // 8. Self-update, last: the next run uses this release's upgrader.
    r.phase("self-update");
    const job = upgraderJobName(deps.env);
    const self = await deps.run([
      "run",
      "jobs",
      "update",
      job,
      `--image=${releaseImageRef("ops", m.digests.ops)}`,
      `--region=${deps.region}`,
      `--project=${deps.projectId}`,
      "--quiet",
    ]);
    if (self.ok) r.info(`The upgrader itself now runs ${m.version}.`);
    else {
      r.warn(
        `The upgrader could not update itself (${self.stderr.trim().slice(0, 300)}); the next update still works, with this run's upgrader.`,
      );
    }
    return finish({ status: "succeeded", reason: null, codes: [], pauseAutoUpdates: false });
  } catch (e) {
    return stopWith(
      "failed",
      ["internal"],
      `The upgrader stopped unexpectedly: ${errorText(e)}. If the site misbehaves, check Settings → Updates and the job's log.`,
    );
  }
}

/**
 * End request `requestId` as `end`, retrying a failed write: the end state
 * is what unblocks the next update, so a transient database error must not
 * leave the request "running" while the run reports success.
 *
 * @returns whether the end was written (false after the last attempt failed)
 */
export async function recordUpdateEnd(
  queue: Pick<UpdateQueue, "finish">,
  requestId: string,
  end: UpdateEnd,
  log: JobLog,
  sleep: Sleep = defaultSleep,
): Promise<boolean> {
  for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt++) {
    try {
      await queue.finish(requestId, end);
      return true;
    } catch (e) {
      log({
        severity: "ERROR",
        message: `could not record the end of request ${requestId} (attempt ${attempt}/${FINISH_ATTEMPTS}): ${errorText(e)}`,
      });
      if (attempt < FINISH_ATTEMPTS) await sleep(attempt * 5_000);
    }
  }
  return false;
}

/** Every digest the revisions serving traffic are known by, per service. */
async function servingDigests(deps: UpgraderJobDeps): Promise<
  | {
      ok: true;
      digests: ServingDigests;
      /** The services' deployed names, for the template hints. */
      services: Readonly<Record<RollSlug, string>>;
    }
  | { ok: false; error: string }
> {
  const digests: Partial<Record<RollSlug, readonly string[]>> = {};
  const services: Partial<Record<RollSlug, string>> = {};
  for (const slug of ["admin", "gateway"] as const) {
    const prefix = `${gcpNamePrefix(deps.env)}-${slug}`;
    const service = await resolveGcpResourceName(
      deps.run,
      "run-service",
      prefix,
      deps.projectId,
      deps.region,
    );
    if (service.status !== "found") {
      return { ok: false, error: lookupFailure(service, `${prefix}* Cloud Run service`, "job") };
    }
    const image = await findServingImage(deps.run, deps.projectId, deps.region, service.name);
    if (!image) return { ok: false, error: `could not read which image the ${slug} serves` };
    digests[slug] = servingImageDigests(image);
    services[slug] = service.name;
  }
  return {
    ok: true,
    digests: digests as ServingDigests,
    services: services as Record<RollSlug, string>,
  };
}

/**
 * The index digests the services' templates pin (#1025): hints for which
 * release to check when the serving revisions name only platform digests,
 * which carry no release tag.
 */
async function templateDigests(
  deps: UpgraderJobDeps,
  services: Readonly<Record<RollSlug, string>>,
): Promise<ServingDigests> {
  const out: Partial<Record<RollSlug, readonly string[]>> = {};
  for (const slug of ["admin", "gateway"] as const) {
    const d = await findTemplateImageDigest(deps.run, deps.projectId, deps.region, services[slug]);
    out[slug] = d ? [d] : [];
  }
  return out as ServingDigests;
}

async function recordFacts(
  queue: UpdateQueue,
  requestId: string,
  m: ReleaseManifest,
  meta: InstallMetadata,
): Promise<void> {
  await queue.record(requestId, {
    manifestSecurity: m.security,
    contractMigrations: m.migrations.contract,
    infraContractRequired: m.infraContractVersion,
    infraContractInstalled: meta.infraContractVersion ?? 0,
    adminDigest: m.digests.admin,
    gatewayDigest: m.digests.gateway,
    opsDigest: m.digests.ops,
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
