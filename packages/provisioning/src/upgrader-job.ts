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
 *   2. read what the install runs from install.json in its ops bucket;
 *   3. fetch the release manifest from the FIXED registry and verify its
 *      signature (release-manifest.ts) — no registry, identity or digest
 *      ever comes from the request, the env or argv;
 *   4. decide (upgrader-assess.ts): refuse a bad signature, a downgrade, a
 *      release below its minFromVersion, an automatic run the policy does
 *      not allow; hand an infrastructure change to Cloud Shell;
 *   5. take a Cloud SQL backup — no backup, no change;
 *   6. app-roll (upgrade/app-roll.ts) with no converge hooks: migrations
 *      with the new admin image, admin then gateway, deep health check,
 *      traffic back onto the previous revisions on any failure;
 *   7. record the new digests + version in install.json;
 *   8. move this job onto the release's own ops image, last.
 *
 * Every step is narrated into `platform_update_events` (upgrader-reporter.ts).
 * All side effects come in through {@link UpgraderJobDeps}, so the whole
 * run is tested against fakes; the real wiring is the
 * `@caelo-cms/platform-updater` package (`caelo-ops upgrader`).
 */

import type {
  PlatformUpdateEventLevel,
  PlatformUpdatePhase,
  PlatformUpdateTrigger,
  StoredUpdatePolicy,
} from "@caelo-cms/shared";
import type { GcloudRunner, Sleep } from "./gcloud-retry.js";
import { gcpNamePrefix, upgraderJobName } from "./gcp-names.js";
import type { InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import {
  type AppRollPlan,
  executeAppRoll,
  planAppRoll,
  type ReleaseImage,
  type RollSlug,
} from "./upgrade/app-roll.js";
import { restoreCommand, takeSqlBackup } from "./upgrade/backup.js";
import { findServingImageDigest, resolveGcpResourceName } from "./upgrade/gcp-lookup.js";
import type { HealthProbe } from "./upgrade/health.js";
import { releaseImageRef } from "./upgrade/release-images.js";
import { assessUpgradeRequest, type RefusalCode } from "./upgrader-assess.js";
import { eventReporter, type JobLog } from "./upgrader-reporter.js";

/** A request the job claimed, with the policy as it stood at claim time. */
export interface ClaimedUpdate {
  readonly id: string;
  readonly targetVersion: string;
  readonly trigger: PlatformUpdateTrigger;
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
  finish(requestId: string, end: UpdateEnd): Promise<void>;
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
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
  /**
   * Take the install's state lock (the one `pulumi up` and `state migrate`
   * hold) for the whole run; returns its release. Throws when another run
   * holds it.
   */
  readonly lockState: () => () => void;
  /** install.json from the install's ops bucket (null when absent). */
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

const ROLLED_PHASES = new Set(["roll", "health"]);

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
    // The end state is what unblocks the next update; a transient database
    // error must not leave the request "running" while the run reports
    // success.
    let recorded = false;
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS && !recorded; attempt++) {
      try {
        await queue.finish(request.id, end);
        recorded = true;
      } catch (e) {
        log({
          severity: "ERROR",
          message: `could not record the end of request ${request.id} (attempt ${attempt}/${FINISH_ATTEMPTS}): ${errorText(e)}`,
        });
        if (attempt < FINISH_ATTEMPTS) await (deps.sleep ?? defaultSleep)(attempt * 5_000);
      }
    }
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

    // Exclusive against the installer's own state writers for the whole run.
    try {
      releaseLock = deps.lockState();
    } catch (e) {
      return stopWith(
        "failed",
        ["state-locked"],
        `Nothing was changed: another install operation is running on this site (${errorText(e)}). Try again when it has finished.`,
      );
    }

    // 2. What the install runs — from its own state, never from the admin.
    r.phase("verify");
    const meta = deps.readInstall();
    if (!meta || meta.projectId !== deps.projectId) {
      return stopWith(
        "needs_cloud_shell",
        ["install-state"],
        "The install's records (install.json) are not in its own cloud project yet, so the upgrader cannot tell what it runs. Run the upgrade once with Cloud Shell; it moves them there.",
      );
    }
    if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
      return stopWith(
        "refused",
        ["provider"],
        `The upgrader job only upgrades Google Cloud installs; this one is ${meta.provider}.`,
      );
    }

    // install.json must describe what actually serves: if a previous run
    // rolled but could not record it, the recorded version is stale and
    // the downgrade / minFromVersion checks would judge against it.
    const serving = await servingDigests(deps);
    if (!serving.ok) {
      return stopWith("failed", ["lookup"], `Nothing was changed: ${serving.error}.`);
    }
    const recorded = meta.imageDigests;
    if (
      !recorded ||
      recorded.admin !== serving.digests.admin ||
      recorded.gateway !== serving.digests.gateway
    ) {
      return stopWith(
        "needs_cloud_shell",
        ["install-state-drift"],
        "The release that serves now is not the one the install's records (install.json) name, so the upgrader cannot tell safely what it runs. Run the upgrade once with Cloud Shell; it records the serving release again.",
      );
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
      return stopWith(decision.status, decision.codes, decision.reason);
    }
    r.phase("assess");
    for (const w of decision.warnings) r.warn(w);
    r.info(
      `${meta.releaseVersion} → ${decision.manifest.version}: no cloud-setup change needed; installing.`,
    );

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
      },
      images,
      deps.run,
    );
    if (!planned.ok) {
      return stopWith("failed", ["plan"], `Nothing was changed: ${planned.error}.`);
    }
    for (const w of planned.plan.warnings) r.warn(w);

    // 5. No backup, no change.
    r.phase("backup");
    const sBak = r.step("Backing up the database before anything changes...");
    const backup = await takeSqlBackup(
      deps.run,
      { projectId: deps.projectId, env: deps.env },
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
        recordDigests: async (digests) => {
          r.phase("record");
          try {
            const fresh = deps.readInstall() ?? meta;
            deps.writeInstall({ ...fresh, imageDigests: digests, releaseVersion: m.version });
            r.info(`Recorded ${m.version} as this install's release.`);
          } catch (e) {
            r.warn(
              `The new release serves, but install.json could not be updated (${errorText(e)}). The next update will stop and ask for one upgrade with Cloud Shell, which records it.`,
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

/** The digests the revisions serving traffic run, per service. */
async function servingDigests(
  deps: UpgraderJobDeps,
): Promise<{ ok: true; digests: Record<RollSlug, string> } | { ok: false; error: string }> {
  const digests: Partial<Record<RollSlug, string>> = {};
  for (const slug of ["admin", "gateway"] as const) {
    const prefix = `${gcpNamePrefix(deps.env)}-${slug}`;
    const service = await resolveGcpResourceName(
      deps.run,
      "run-service",
      prefix,
      deps.projectId,
      deps.region,
    );
    const digest = service
      ? await findServingImageDigest(deps.run, deps.projectId, deps.region, service)
      : null;
    if (!digest) return { ok: false, error: `could not read which image the ${slug} serves` };
    digests[slug] = digest;
  }
  return { ok: true, digests: digests as Record<RollSlug, string> };
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
