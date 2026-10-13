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
 * against a fake gcloud in tests. lifecycle.ts wires the real ones.
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
import { backupFailureHelp, restoreCommand, takeSqlBackup } from "./backup.js";
import { startConverge } from "./converge.js";
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
  readonly healthProbe: (
    plan: AppRollPlan,
  ) => Promise<
    | { readonly ok: true; readonly probe: HealthProbe }
    | { readonly ok: false; readonly error: string }
  >;
  readonly recordDigests: (digests: ImageDigests) => Promise<void>;
  readonly recordInfraContractVersion: (version: number) => void;
  /** The operator-identity converge step (keyless provisioner); see ConvergeDeps. */
  readonly provisionerIdentity?: () => Promise<boolean>;
  /** Today, for the backup's description. */
  readonly now?: () => Date;
}

/** Upgrade one install; true on success. See the file comment for the order. */
export async function upgradeGcpInstall(
  target: GcpUpgradeTarget,
  deps: GcpUpgradeDeps,
): Promise<boolean> {
  const { reporter: r, run } = deps;
  const { projectId } = target;

  // 1. Plan. Nothing changes until every lookup succeeded.
  const sPre = r.step("Pre-flight: resolving services + image digests + current revisions...");
  const images = await deps.resolveImages(target.targetTag);
  if (!images.ok) {
    sPre.failed("Couldn't resolve the release images");
    r.error(images.error);
    return false;
  }
  const planned = await planAppRoll(
    {
      provider: target.provider,
      projectId,
      region: target.region,
      env: target.env,
      domain: target.domain,
      stagingHost: target.stagingHost,
    },
    images.images,
    run,
  );
  if (!planned.ok) {
    sPre.failed("Pre-flight failed");
    r.error(planned.error);
    return false;
  }
  const plan = planned.plan;
  sPre.done(`Pre-flight ok — ${plan.services.length} services planned`);
  reportPlan(plan, r);

  // 2. P21 ship 4 — signatures against the Caelo release workflow's
  // identity: refuses a compromised registry, a typosquat or a fork's image.
  if (!target.skipVerify) {
    if (!(await deps.verifyImages(plan.services))) return false;
  } else {
    r.warn("--skip-verify set — image signatures NOT verified.");
  }

  // 3. The first change: a failure leaves the install exactly as it was.
  const sBak = r.step("Taking a pre-upgrade Cloud SQL backup...");
  const backup = await takeSqlBackup(
    run,
    { projectId, env: target.env },
    `pre-upgrade to ${target.targetTag}`,
    deps.now,
  );
  if (!backup.ok) {
    sBak.failed(`Pre-upgrade backup failed: ${backup.error}`);
    r.warn(backupFailureHelp({ projectId }));
    return false;
  }
  sBak.done(`Pre-upgrade backup ${backup.backup.backupId} of ${backup.backup.instance} taken`);

  // 4. Converge, the part before the roll.
  const converge = startConverge(plan, target.ownerEmail, {
    run,
    reporter: r,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.http ? { http: deps.http } : {}),
    ...(deps.provisionerIdentity ? { provisionerIdentity: deps.provisionerIdentity } : {}),
  });
  if (!(await converge.beforeAppRoll())) return false;

  // 5. App-roll, with the converge steps that sit between its own.
  let health: HealthProbe | null = null;
  if (!target.skipHealthCheck) {
    const probe = await deps.healthProbe(plan);
    if (!probe.ok) {
      r.error(probe.error);
      r.warn("No migrations ran and no traffic moved.");
      return false;
    }
    health = probe.probe;
  }
  const rolled = await executeAppRoll(
    {
      plan,
      backup: backup.backup,
      targetVersion: /^\d+\.\d+\.\d+/.test(target.targetTag) ? target.targetTag : null,
      // Unknown until the signed release manifest names it (epic #696).
      migrationsContract: null,
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
  if (!rolled.ok) return false;
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
  return true;
}
