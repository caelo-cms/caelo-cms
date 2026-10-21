// SPDX-License-Identifier: MPL-2.0

/**
 * The real side effects of the converge job on Google Cloud (#819):
 * gcloud as the job's own identity (the install's caelo-provisioner), the
 * install's ops bucket for install.json, the state lock and the checkpoint,
 * the fixed release registry, cosign, and — for stage 2 — the terminal's
 * upgrade itself (upgrade/upgrade.ts) wired the way lifecycle.ts wires it,
 * minus the operator-identity step: this run IS the provisioner.
 * converge-job.ts takes them as {@link ConvergeJobDeps}; the database queue
 * and the job log come from `@caelo-cms/platform-updater`.
 *
 * Nothing here reads the process env or argv (CLOUD_RUN_EXECUTION, read by
 * the entry point, only names this run): what the job may install and from
 * where is compiled in (release-manifest.ts's registry + signer), and where
 * it runs comes from the metadata server.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { readConvergeCheckpoint, writeConvergeCheckpoint } from "./converge-checkpoint.js";
import type { ConvergeJobDeps, ConvergeQueue, ConvergeUpgradeOutcome } from "./converge-job.js";
import { CONVERGE_TASK_TIMEOUT_MINUTES } from "./converge-job-setup.js";
import { gcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep } from "./gcloud-retry.js";
import {
  convergeJobName,
  GCP_STACK_ENV,
  gcpNamePrefix,
  operatorAccessJobName,
} from "./gcp-names.js";
import { INFRA_CONTRACT_VERSION } from "./infra-contract.js";
import { describeExecution } from "./install-job.js";
import {
  type InstallMetadata,
  installRoot,
  installStagingHost,
  readMetadata,
  recordInfraContractVersion,
} from "./install-state.js";
import { runMigrationsViaCloudRunJob } from "./migration-runner.js";
import { installIapAllowlist } from "./operator-access.js";
import { fetchVerifiedReleaseManifest } from "./release-manifest.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { publicSiteUrl, STAGING_HOST_ENV } from "./stack-contract.js";
import { attachInstall } from "./state-attach.js";
import { hasLocalPulumiState, opsBucketName } from "./state-backend.js";
import { acquireBucketStateLock, GcsStateStore, realSyncGcloud } from "./state-store.js";
import { resolveGcpResourceName } from "./upgrade/gcp-lookup.js";
import { releaseImageRef, verifyCosignAll } from "./upgrade/release-images.js";
import { upgradeGcpInstallOutcome } from "./upgrade/upgrade.js";
import { gcloudIamTester, healthProbeFor, type UpgraderPlacement } from "./upgrader-gcp.js";
import type { JobLog } from "./upgrader-reporter.js";

const DIGEST = /@(sha256:[0-9a-f]{64})/;

/**
 * The image digest an execution of the converge job runs, from its Cloud
 * Run description (the execution's task template names the image it was
 * started with). Null when it cannot be read or names no digest.
 */
export function executionImageDigest(describeJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch {
    return null;
  }
  // gcloud prints the v1 resource (spec.template.spec.containers); the v2
  // shape (template.containers) is accepted too. The first container is it.
  const p = parsed as {
    spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
    template?: { containers?: { image?: string }[] };
  };
  const image =
    p.spec?.template?.spec?.containers?.[0]?.image ?? p.template?.containers?.[0]?.image ?? "";
  return DIGEST.exec(image)?.[1] ?? null;
}

/** The operator-access job's env var listing the install's fixed IAP members. */
const STATIC_MEMBERS_ENV = "CAELO_OPERATOR_ACCESS_STATIC_MEMBERS";

/** The admin env var naming the public site (stack-contract.ts adminEnvContract). */
const SITE_URL_ENV = "CAELO_SITE_URL";

/**
 * Why install.json's Owner email does not match the IAP members the
 * deployed operator-access job admits (operator-access.ts deploys them as
 * `installIapAllowlist(ownerEmail)`), or null when it does. Read from
 * `gcloud run jobs describe --format=json` (v1 or v2 shape).
 */
export function deployedOwnerMismatch(describeJson: string, ownerEmail: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch {
    return "the operator-access job's description is not JSON";
  }
  const p = parsed as {
    spec?: {
      template?: {
        spec?: {
          template?: { spec?: { containers?: { env?: { name?: string; value?: string }[] }[] } };
        };
      };
    };
    template?: { template?: { containers?: { env?: { name?: string; value?: string }[] }[] } };
  };
  const env =
    p.spec?.template?.spec?.template?.spec?.containers?.[0]?.env ??
    p.template?.template?.containers?.[0]?.env ??
    [];
  const deployed = env.find((e) => e.name === STATIC_MEMBERS_ENV)?.value;
  if (deployed === undefined) return `the operator-access job sets no ${STATIC_MEMBERS_ENV}`;
  const want = installIapAllowlist(ownerEmail).join(",");
  const have = deployed
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
  if (have !== [...installIapAllowlist(ownerEmail)].sort().join(",")) {
    return `the admin admits ${deployed || "nobody"}, the records would make it ${want}`;
  }
  return null;
}

/**
 * Why install.json's site does not match what the admin serves today, or
 * null when it does (#883 review, round 2). install.json is writable by the
 * upgrader's account, and the converge hands its domain, staging host and
 * region to code running as the provisioner: a tampered record would have
 * the provisioner point the site, its certificate and its IAP gate at
 * another domain. So the job converges only onto the site the deployed
 * admin already serves (`CAELO_SITE_URL`, `CAELO_STAGING_HOST`, from
 * `gcloud run services describe --format=json`) in the region this job
 * runs in. A change of domain is a terminal upgrade by the Owner.
 *
 * @param adminJson the admin service's description (v1 or v2 shape)
 * @param region the region this job runs in (the metadata server's)
 */
export function deployedSiteMismatch(
  adminJson: string,
  meta: Pick<InstallMetadata, "domain" | "stagingDomain" | "region">,
  region: string,
): string | null {
  if (meta.region !== region) {
    return `the records name region ${meta.region ?? "none"}, the converge job runs in ${region}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(adminJson);
  } catch {
    return "the admin's description is not JSON";
  }
  const p = parsed as {
    spec?: {
      template?: { spec?: { containers?: { env?: { name?: string; value?: string }[] }[] } };
    };
    template?: { containers?: { env?: { name?: string; value?: string }[] }[] };
  };
  const env =
    p.spec?.template?.spec?.containers?.[0]?.env ?? p.template?.containers?.[0]?.env ?? [];
  const value = (name: string) => env.find((e) => e.name === name)?.value;
  const site = value(SITE_URL_ENV);
  if (site === undefined) return `the admin sets no ${SITE_URL_ENV}`;
  if (site !== publicSiteUrl(meta.domain)) {
    return `the admin serves ${site}, the records would make it ${publicSiteUrl(meta.domain)}`;
  }
  // An admin from before #650 has no staging host yet; this converge adds
  // it, but only the default one derived from the domain.
  const staging = value(STAGING_HOST_ENV);
  const want = installStagingHost(meta);
  const defaultHost = installStagingHost({ domain: meta.domain });
  if (staging === undefined ? want !== defaultHost : staging !== want) {
    return `the admin's staging host is ${staging ?? "unset"}, the records would make it ${want}`;
  }
  return null;
}

/**
 * Why `CLOUD_RUN_EXECUTION` cannot name a run of the converge job, or null
 * when it can. The name keys the state lock's holder and the hand-over
 * between the job's two stages, so a value that names another job's run
 * (or is not a Cloud Run name at all) stops the job before it acts
 * (#883 review). Cloud Run sets it and rejects user values for it; this is
 * the second line.
 */
export function convergeExecutionNameError(execution: string | null): string | null {
  if (execution === null) return null;
  const prefix = `${convergeJobName(GCP_STACK_ENV)}-`;
  if (!/^[a-z0-9-]{1,63}$/.test(execution) || !execution.startsWith(prefix)) {
    return `CLOUD_RUN_EXECUTION is "${execution.slice(0, 80)}", not a run of ${convergeJobName(GCP_STACK_ENV)}`;
  }
  return null;
}

/** The new execution's name from `gcloud run jobs execute --async`. */
export function startedExecutionName(stdout: string, stderr: string): string | null {
  const name = stdout.trim().split(/\s+/)[0] || /Execution \[([^\]]+)\]/.exec(stderr)?.[1] || "";
  return /^[a-z0-9-]+$/.test(name) ? name : null;
}

/** Every dependency of {@link runConvergeJob} except the database and the log. */
export function gcpConvergeDeps(
  placement: UpgraderPlacement,
  queue: ConvergeQueue,
  log: JobLog,
): ConvergeJobDeps {
  const run: GcloudRunner = gcloud;
  const http = fetch as unknown as HttpFetch;
  const { projectId, region } = placement;
  const bucket = opsBucketName(projectId);
  const job = convergeJobName(GCP_STACK_ENV);
  const location = [`--region=${region}`, `--project=${projectId}`];
  // Peeks only (uncached); the upgrade writes through install-state.ts.
  const store = new GcsStateStore(bucket, mkdtempSync(join(tmpdir(), "caelo-converge-")));

  const upgrade: ConvergeJobDeps["upgrade"] = async ({
    manifest: m,
    reporter,
    resume,
    onCheckpoint,
  }) => {
    // The container starts empty: mirror the install from its bucket, as
    // the install job does, so install-state.ts reads and writes it there.
    const attached = attachInstall(projectId, {
      run: realSyncGcloud,
      rootFor: installRoot,
      hasLocalState: hasLocalPulumiState,
    });
    if (!attached.ok) {
      reporter.error(`Could not read the install's records: ${attached.error}`);
      return { ok: false, rolledBack: false, unrecorded: false };
    }
    const installId = attached.installId;
    // Lazily: the CLI's lifecycle module (clack, the wizards' Pulumi
    // helpers) is only needed by stage 2, never by the package's importers.
    const { recordRolledRelease } = await import("./lifecycle.js");
    const meta = readMetadata(installId) as InstallMetadata;
    if ((meta.provider !== "gcp" && meta.provider !== "gcp-firebase") || !meta.region) {
      reporter.error(`install.json of ${installId} is not a Google Cloud install with a region.`);
      return { ok: false, rolledBack: false, unrecorded: false };
    }
    // #883 review — install.json is writable by the upgrader's account
    // (install/ in the ops bucket), and this job runs as the provisioner:
    // the Owner email it hands the converge decides who passes the admin's
    // IAP gate. Converge only when it matches what is deployed today; a
    // change of Owner is a terminal upgrade by the Owner.
    const access = await run([
      "run",
      "jobs",
      "describe",
      operatorAccessJobName(GCP_STACK_ENV),
      ...location,
      "--format=json",
    ]);
    const ownerCheck = access.ok
      ? deployedOwnerMismatch(access.stdout, meta.ownerEmail)
      : `the deployed operator-access job could not be read (${access.stderr.trim()})`;
    if (ownerCheck) {
      reporter.error(
        `Nothing was changed: the install's records name ${meta.ownerEmail} as Owner, which this update could not confirm against the admin's current access settings (${ownerCheck}). Run the update once from Cloud Shell or the computer you installed from.`,
      );
      return { ok: false, rolledBack: false, unrecorded: false };
    }
    const admin = await resolveGcpResourceName(
      run,
      "run-service",
      `${gcpNamePrefix(GCP_STACK_ENV)}-admin`,
      projectId,
      region,
    );
    const described = admin
      ? await run(["run", "services", "describe", admin, ...location, "--format=json"])
      : null;
    const siteCheck = !admin
      ? "the admin service could not be found"
      : described?.ok
        ? deployedSiteMismatch(described.stdout, meta, region)
        : `the admin's description could not be read (${described?.stderr.trim() ?? ""})`;
    if (siteCheck) {
      reporter.error(
        `Nothing was changed: the install's records name ${meta.domain} in ${meta.region}, which this update could not confirm against what the admin serves today (${siteCheck}). Run the update once from Cloud Shell or the computer you installed from.`,
      );
      return { ok: false, rolledBack: false, unrecorded: false };
    }
    let recorded = true;
    let converged = false;
    const outcome = await upgradeGcpInstallOutcome(
      {
        provider: meta.provider,
        projectId,
        region: meta.region,
        env: GCP_STACK_ENV,
        domain: meta.domain,
        stagingHost: installStagingHost(meta),
        ownerEmail: meta.ownerEmail,
        targetTag: m.version,
        // This code is the target release's (stage 2), so its contract is it.
        infraContractVersion: INFRA_CONTRACT_VERSION,
        skipVerify: false,
        skipHealthCheck: false,
        migrationsContract: m.migrations.contract,
      },
      {
        run,
        http,
        sleep: realSleep,
        reporter,
        // The signed manifest's digests — never a registry tag lookup.
        resolveImages: async () => ({
          ok: true,
          images: {
            admin: { digest: m.digests.admin, imageRef: releaseImageRef("admin", m.digests.admin) },
            gateway: {
              digest: m.digests.gateway,
              imageRef: releaseImageRef("gateway", m.digests.gateway),
            },
          },
        }),
        verifyImages: verifyCosignAll,
        migrate: (imageRef) =>
          runMigrationsViaCloudRunJob(
            { projectId, region: meta.region as string, imageOverride: imageRef },
            { run },
          ),
        healthProbe: (plan) => healthProbeFor(run, http, plan),
        recordDigests: async (digests) => {
          recorded = await recordRolledRelease(
            installId,
            meta.provider as "gcp" | "gcp-firebase",
            digests,
            m.version,
          );
        },
        resolveOpsImage: async () => releaseImageRef("ops", m.digests.ops),
        recordInfraContractVersion: (version) => {
          recordInfraContractVersion(installId, version);
          converged = true;
        },
        ...(resume ? { resume } : {}),
        onCheckpoint,
      },
    );
    // rolled_back only when the rollback really put the previous release
    // back (app-roll.ts reports it structurally), never from log text.
    const result: ConvergeUpgradeOutcome =
      outcome.ok && recorded
        ? { ok: true, converged }
        : {
            ok: false,
            rolledBack: !outcome.ok && outcome.rolledBack,
            unrecorded: outcome.ok && !recorded,
          };
    return result;
  };

  return {
    queue,
    projectId,
    region,
    iam: gcloudIamTester(run, http),
    execution: placement.execution,
    ownVersion: CAELO_VERSION,
    // The default deps: the fixed registry and signer, never overridden.
    fetchManifest: (version) => fetchVerifiedReleaseManifest(version),
    readInstall: () => {
      const text = store.peek("install.json");
      return text === null ? null : (JSON.parse(text) as InstallMetadata);
    },
    verifyImage: (slug, digest) => verifyCosignAll([{ slug, digest }]),
    ownImageDigest: async () => {
      if (!placement.execution) return null;
      const r = await run([
        "run",
        "jobs",
        "executions",
        "describe",
        placement.execution,
        ...location,
        "--format=json",
      ]);
      return r.ok ? executionImageDigest(r.stdout) : null;
    },
    pointJobAt: async (digest) => {
      // Only the image changes: the identity, command and args stay what
      // converge-job-setup.ts deployed.
      const update = await run([
        "run",
        "jobs",
        "update",
        job,
        `--image=${releaseImageRef("ops", digest)}`,
        ...location,
        "--quiet",
      ]);
      return update.ok
        ? { ok: true }
        : { ok: false, error: `update ${job}: ${update.stderr.trim()}` };
    },
    startJob: async () => {
      const exec = await run([
        "run",
        "jobs",
        "execute",
        job,
        ...location,
        "--async",
        "--format=value(metadata.name)",
      ]);
      if (!exec.ok) return { ok: false, error: `start ${job}: ${exec.stderr.trim()}` };
      const execution = startedExecutionName(exec.stdout, exec.stderr);
      if (!execution) {
        return {
          ok: false,
          error: `${job} started but gcloud did not name the execution (${exec.stderr.trim()})`,
        };
      }
      return { ok: true, execution };
    },
    executionState: (execution) => describeExecution(run, { projectId, region, execution }),
    // #815 — the lock names this execution; a later run breaks it once
    // Cloud Run says this one has ended (killed at its task timeout).
    lockState: (onBreak) =>
      acquireBucketStateLock(bucket, "caelo converge job", realSyncGcloud, {
        onBreak,
        ...(placement.execution
          ? {
              holder: {
                execution: { projectId, region, name: placement.execution },
                maxRuntimeMs: CONVERGE_TASK_TIMEOUT_MINUTES * 60_000,
              },
            }
          : {}),
      }),
    readCheckpoint: () => readConvergeCheckpoint(bucket, realSyncGcloud),
    writeCheckpoint: (checkpoint) => writeConvergeCheckpoint(bucket, checkpoint, realSyncGcloud),
    upgrade,
    now: () => new Date(),
    log,
  };
}
