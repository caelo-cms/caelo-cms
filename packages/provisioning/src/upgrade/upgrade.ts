// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision upgrade` for one gcp / gcp-firebase install: converge, then
 * app-roll (epic #696). The order, and why:
 *
 *   1. plan (read-only): release digests, both services, the env contract
 *   2. verify the images' signatures
 *   3. pre-upgrade Cloud SQL backup — the first change; if it fails, the
 *      install is exactly as it was
 *   4. converge, the part before the roll (keyless provisioner, IAM, secrets,
 *      MCP access)
 *   5. app-roll: health baseline, migrations, the converge steps that must
 *      follow migrations, admin + gateway rolls, deep health check, rollback
 *      on failure, recorded digests
 *   6. converge, the part after the roll; a complete converge records the
 *      install's infrastructure contract version
 *
 * Every side effect goes through {@link GcpUpgradeDeps}, so the sequence runs
 * against a fake gcloud in tests. lifecycle.ts wires the real ones for the
 * terminal; converge-job-gcp.ts wires them for the converge job (#819),
 * which runs this same sequence from inside the install's project. The job
 * may be killed mid-way and started again, so the sequence reports its two
 * facts a resumed run must not recompute — the pre-upgrade backup and the
 * revisions that served before ({@link UpgradeCheckpoint}) — and accepts
 * them back: a resumed run neither backs up the half-migrated database
 * again nor rolls back onto a revision the interrupted run created.
 */

import type { GcloudRunner, Sleep } from "../gcloud-retry.js";
import type { ImageDigests } from "../install-state.js";
import type { HttpFetch } from "../runtime-secrets.js";
import {
  type AppRollPlan,
  executeAppRoll,
  planAppRoll,
  type ReleaseImage,
  type RollSlug,
  reportPlan,
} from "./app-roll.js";
import { backupFailureHelp, restoreCommand, type SqlBackup, takeSqlBackup } from "./backup.js";
import { startConverge } from "./converge.js";
import type { GcloudCredentials } from "./gcp-lookup.js";
import type { HealthProbe } from "./health.js";
import type { UpgradeReporter } from "./reporter.js";

export interface GcpUpgradeTarget {
  readonly provider: "gcp" | "gcp-firebase";
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  readonly domain: string;
  readonly stagingHost: string;
  readonly ownerEmail: string;
  /** The tag rolled to: a version (`0.11.0`) or a channel tag (`latest`, `rc`). */
  readonly targetTag: string;
  /** The infrastructure contract version this CLI converges to (infra-contract.ts). */
  readonly infraContractVersion: number;
  readonly skipVerify: boolean;
  readonly skipHealthCheck: boolean;
  /**
   * Whether the release's migrations are contract-type, from the signed
   * release manifest (the converge job knows it; the terminal does not).
   */
  readonly migrationsContract?: boolean | null;
  /** Whose gcloud credentials run the sequence: the Owner's, or the converge job's (#630). */
  readonly credentials: GcloudCredentials;
}

/**
 * What an upgrade run has fixed that a resumed run must reuse (#819): the
 * backup taken before anything changed, and the revisions that served
 * before — the rollback targets.
 */
export interface UpgradeCheckpoint {
  readonly backup?: SqlBackup;
  readonly priorRevisions?: Readonly<Record<RollSlug, string>>;
}

export interface GcpUpgradeDeps {
  readonly run: GcloudRunner;
  readonly reporter: UpgradeReporter;
  readonly sleep?: Sleep;
  /** Cloud SQL Admin API calls (database role passwords). */
  readonly http?: HttpFetch;
  readonly resolveImages: (
    tag: string,
  ) => Promise<
    | { readonly ok: true; readonly images: Record<RollSlug, ReleaseImage> }
    | { readonly ok: false; readonly error: string }
  >;
  readonly verifyImages: (images: readonly { slug: string; digest: string }[]) => Promise<boolean>;
  readonly migrate: (
    imageRef: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  /**
   * The health probe for `plan`'s install. `accessJustChanged`: the
   * converge before it changed access the probe relies on, so its baseline
   * waits for that to take effect (health.ts, #734).
   */
  readonly healthProbe: (
    plan: AppRollPlan,
    context: { readonly accessJustChanged: boolean },
  ) => Promise<
    | { readonly ok: true; readonly probe: HealthProbe }
    | { readonly ok: false; readonly error: string }
  >;
  readonly recordDigests: (digests: ImageDigests) => Promise<void>;
  /**
   * The release's caelo-ops image (`…/ops@sha256:…`) for the upgrader job
   * the converge sets up (#696), or null when the tag has none.
   */
  readonly resolveOpsImage: (tag: string) => Promise<string | null>;
  readonly recordInfraContractVersion: (version: number) => void;
  /** The operator-identity converge step (keyless provisioner); see ConvergeDeps. */
  readonly provisionerIdentity?: () => Promise<boolean>;
  /** Today, for the backup's description. */
  readonly now?: () => Date;
  /** #819 — what an interrupted run of this same upgrade already fixed. */
  readonly resume?: UpgradeCheckpoint;
  /** #819 — called once each checkpoint fact is known (before it is relied on). */
  readonly onCheckpoint?: (checkpoint: UpgradeCheckpoint) => void;
}

/** How {@link upgradeGcpInstallOutcome} ended. */
export type GcpUpgradeOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * The roll failed AND every rolled service was pinned back to the
       * revision that served before (app-roll.ts AppRollResult): the
       * previous release serves again. Structural, never read from text.
       */
      readonly rolledBack: boolean;
    };

/** Upgrade one install; true on success. See the file comment for the order. */
export async function upgradeGcpInstall(
  target: GcpUpgradeTarget,
  deps: GcpUpgradeDeps,
): Promise<boolean> {
  return (await upgradeGcpInstallOutcome(target, deps)).ok;
}

/**
 * {@link upgradeGcpInstall} with how a failure ended: whether the previous
 * release serves again after a rollback (the converge job reports
 * rolled_back only then, #819 review).
 */
export async function upgradeGcpInstallOutcome(
  target: GcpUpgradeTarget,
  deps: GcpUpgradeDeps,
): Promise<GcpUpgradeOutcome> {
  const failed: GcpUpgradeOutcome = { ok: false, rolledBack: false };
  const { reporter: r, run } = deps;
  const { projectId } = target;

  // 1. Plan. Nothing changes until every lookup succeeded.
  const sPre = r.step("Pre-flight: resolving services + image digests + current revisions...");
  const images = await deps.resolveImages(target.targetTag);
  if (!images.ok) {
    sPre.failed("Couldn't resolve the release images");
    r.error(images.error);
    return failed;
  }
  const planned = await planAppRoll(
    {
      provider: target.provider,
      projectId,
      region: target.region,
      env: target.env,
      domain: target.domain,
      stagingHost: target.stagingHost,
      credentials: target.credentials,
    },
    images.images,
    run,
  );
  if (!planned.ok) {
    sPre.failed("Pre-flight failed");
    r.error(planned.error);
    return failed;
  }
  const plan = withPriorRevisions(planned.plan, deps, r);
  sPre.done(`Pre-flight ok — ${plan.services.length} services planned`);
  reportPlan(plan, r);

  // 2. P21 ship 4 — signatures against the Caelo release workflow's
  // identity: refuses a compromised registry, a typosquat or a fork's image.
  if (!target.skipVerify) {
    if (!(await deps.verifyImages(plan.services))) return failed;
  } else {
    r.warn("--skip-verify set — image signatures NOT verified.");
  }

  // 3. The first change: a failure leaves the install exactly as it was.
  //    A resumed run keeps the interrupted run's backup: a new one could
  //    already hold the half-migrated schema.
  let backup: { readonly ok: true; readonly backup: SqlBackup };
  if (deps.resume?.backup) {
    backup = { ok: true, backup: deps.resume.backup };
    r.info(
      `Continuing an interrupted update: keeping its pre-upgrade backup ${backup.backup.backupId}.`,
    );
  } else {
    const sBak = r.step("Taking a pre-upgrade Cloud SQL backup...");
    const taken = await takeSqlBackup(
      run,
      { projectId, env: target.env, credentials: target.credentials },
      `pre-upgrade to ${target.targetTag}`,
      deps.now,
    );
    if (!taken.ok) {
      sBak.failed(`Pre-upgrade backup failed: ${taken.error}`);
      r.warn(backupFailureHelp({ projectId }));
      return failed;
    }
    sBak.done(`Pre-upgrade backup ${taken.backup.backupId} of ${taken.backup.instance} taken`);
    backup = taken;
    deps.onCheckpoint?.({ backup: taken.backup });
  }

  // 4. Converge, the part before the roll. The upgrader job runs the ops
  //    image with rights over the whole app, so it is deployed only when its
  //    signature checks out (an unverified image is never set up).
  const opsImageRef = await verifiedOpsImage(target, deps);
  const converge = startConverge(plan, target.ownerEmail, {
    opsImageRef,
    run,
    reporter: r,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.http ? { http: deps.http } : {}),
    ...(deps.provisionerIdentity ? { provisionerIdentity: deps.provisionerIdentity } : {}),
  });
  if (!(await converge.beforeAppRoll())) return failed;

  // 5. App-roll, with the converge steps that sit between its own.
  let health: HealthProbe | null = null;
  if (!target.skipHealthCheck) {
    const probe = await deps.healthProbe(plan, {
      accessJustChanged: converge.accessJustChanged(),
    });
    if (!probe.ok) {
      r.error(probe.error);
      r.warn("No migrations ran and no traffic moved.");
      return failed;
    }
    health = probe.probe;
  }
  const rolled = await executeAppRoll(
    {
      plan,
      backup: backup.backup,
      targetVersion: /^\d+\.\d+\.\d+/.test(target.targetTag) ? target.targetTag : null,
      // Unknown on the terminal path until the signed release manifest names it.
      migrationsContract: target.migrationsContract ?? null,
    },
    converge.hooks,
    {
      run,
      reporter: r,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      migrate: deps.migrate,
      health,
      recordDigests: deps.recordDigests,
    },
  );
  if (!rolled.ok) return { ok: false, rolledBack: rolled.rolledBack };
  r.success(`Upgrade to ${target.targetTag} complete (admin + gateway revisions serving).`);
  r.info(
    `Pre-upgrade backup: ${backup.backup.backupId} (restore: ${restoreCommand(backup.backup)})`,
  );

  // 6. Converge, the part after the roll.
  await converge.afterAppRoll();
  if (converge.complete()) {
    try {
      deps.recordInfraContractVersion(target.infraContractVersion);
    } catch (e) {
      r.warn(
        `Could not record the infrastructure contract version (${e instanceof Error ? e.message : String(e)}); the next upgrade converges again.`,
      );
    }
  } else {
    r.warn(
      "Some converge steps did not succeed (see above); the install is not marked as converged, so in-product updates stay unavailable until a re-run of upgrade completes them.",
    );
  }
  return { ok: true };
}

/**
 * The plan with the rollback targets an interrupted run recorded (#819): it
 * may have rolled a service already, so the revision serving NOW would be
 * the new release's. A fresh run records the planned ones instead.
 */
function withPriorRevisions(
  plan: AppRollPlan,
  deps: GcpUpgradeDeps,
  r: UpgradeReporter,
): AppRollPlan {
  const recorded = deps.resume?.priorRevisions;
  if (!recorded) {
    const prior = Object.fromEntries(plan.services.map((s) => [s.slug, s.priorRevision])) as Record<
      RollSlug,
      string
    >;
    deps.onCheckpoint?.({ priorRevisions: prior });
    return plan;
  }
  return {
    ...plan,
    services: plan.services.map((s) => {
      const before = recorded[s.slug];
      if (before === s.priorRevision) return s;
      r.info(
        `Continuing an interrupted update: ${s.slug} goes back to ${before} (what served before it started) if the new release fails its checks.`,
      );
      return { ...s, priorRevision: before };
    }),
  };
}

/**
 * The release's caelo-ops image for the upgrader job, signature-verified
 * like the admin and gateway images; null (with the reason printed) when
 * there is none, it does not verify, or verification was skipped.
 */
async function verifiedOpsImage(
  target: GcpUpgradeTarget,
  deps: GcpUpgradeDeps,
): Promise<string | null> {
  const r = deps.reporter;
  const ref = await deps.resolveOpsImage(target.targetTag);
  const digest = ref ? /@(sha256:[0-9a-f]{64})$/.exec(ref)?.[1] : undefined;
  if (!ref || !digest) {
    r.warn(
      `The release ${target.targetTag} has no caelo-ops image in the registry, so the upgrader job (in-product updates) cannot be set up this time.`,
    );
    return null;
  }
  if (target.skipVerify) {
    r.warn(
      "--skip-verify set — the upgrader job is not set up or updated without a verified image.",
    );
    return null;
  }
  if (!(await deps.verifyImages([{ slug: "ops", digest }]))) {
    r.warn(
      "The caelo-ops image's signature did not verify, so the upgrader job is not set up or updated.",
    );
    return null;
  }
  return ref;
}
