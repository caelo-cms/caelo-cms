// SPDX-License-Identifier: MPL-2.0

/**
 * The real side effects of the upgrader job on Google Cloud (epic #696):
 * gcloud as the job's own service account, the install's ops bucket for
 * install.json, the fixed release registry, the migration job, the IAP
 * health probe and the IAM self-check (#818). upgrader-job.ts takes them as {@link UpgraderJobDeps}; the
 * database queue and the job log come from `@caelo-cms/platform-updater`,
 * which owns the Query API connection.
 *
 * Nothing here reads the process env or argv: what the job may install and
 * from where is compiled in (release-manifest.ts's registry + signer), and
 * where it runs comes from the metadata server.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import type { InstallMetadata } from "./install-state.js";
import { readAdminConfig, runMigrationsViaCloudRunJob } from "./migration-runner.js";
import { fetchVerifiedReleaseManifest } from "./release-manifest.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { opsBucketName } from "./state-backend.js";
import { acquireBucketStateLock, GcsStateStore, realSyncGcloud } from "./state-store.js";
import type { AppRollPlan } from "./upgrade/app-roll.js";
import { findServiceUrl } from "./upgrade/gcp-lookup.js";
import { createIapHealthProbe } from "./upgrade/health.js";
import { restIamTester } from "./upgrader-iam-preflight.js";
import type { UpdateQueue, UpgraderJobDeps } from "./upgrader-job.js";
import type { JobLog } from "./upgrader-reporter.js";
import { UPGRADER_TASK_TIMEOUT_MINUTES } from "./upgrader-setup.js";

/** Where the job runs, from the metadata server. */
export interface UpgraderPlacement {
  readonly projectId: string;
  readonly region: string;
  readonly execution: string | null;
}

/**
 * The Cloud SQL private IP the admin connects to — the job connects there
 * too (as its own IAM database user). Read from the deployed admin service.
 */
export async function upgraderDatabaseHost(
  placement: Pick<UpgraderPlacement, "projectId" | "region">,
  run: GcloudRunner = gcloud,
): Promise<string> {
  const cfg = await readAdminConfig(placement, run);
  if (!cfg) {
    throw new Error(
      `could not read the admin service's database host in ${placement.projectId}/${placement.region}`,
    );
  }
  return cfg.databaseHost;
}

/**
 * The IAP-backed deep health probe for `plan`'s install (the upgrader job;
 * the converge job, #819, too). `accessJustChanged`: a converge right
 * before changed access the probe relies on (health.ts); the upgrader job
 * changes none.
 */
export async function healthProbeFor(
  run: GcloudRunner,
  http: HttpFetch,
  plan: AppRollPlan,
  context: { readonly accessJustChanged: boolean },
) {
  const { install } = plan;
  const urls: Partial<Record<"admin" | "gateway", string>> = {};
  for (const s of plan.services) {
    const url = await findServiceUrl(run, install.projectId, install.region, s.serviceName);
    if (!url) {
      return { ok: false as const, error: `could not read the ${s.slug} service's URL` };
    }
    urls[s.slug] = url;
  }
  return {
    ok: true as const,
    probe: createIapHealthProbe(
      {
        provider: install.provider,
        projectId: install.projectId,
        domain: install.domain,
        adminServiceUrl: urls.admin as string,
        gatewayServiceUrl: urls.gateway as string,
      },
      { run, http, sleep: realSleep, accessJustChanged: context.accessJustChanged },
    ),
  };
}

/** Every dependency of {@link runUpgraderJob} except the database and the log. */
export function gcpUpgraderDeps(
  placement: UpgraderPlacement,
  queue: UpdateQueue,
  log: JobLog,
): UpgraderJobDeps {
  const run: GcloudRunner = gcloud;
  const http = fetch as unknown as HttpFetch;
  // The bucket store mirrors to a local dir; in the job that is scratch.
  const store = new GcsStateStore(
    opsBucketName(placement.projectId),
    mkdtempSync(join(tmpdir(), "caelo-upgrader-")),
  );
  return {
    queue,
    run,
    sleep: realSleep,
    projectId: placement.projectId,
    region: placement.region,
    env: GCP_STACK_ENV,
    execution: placement.execution,
    // #818 — the IAM self-check asks as the job's own account (gcloud's
    // token from the metadata server), so it sees exactly the job's grants.
    iam: restIamTester({
      http,
      token: async () => {
        const t = await run(["auth", "print-access-token"]);
        if (!t.ok) throw new Error(`gcloud auth print-access-token: ${t.stderr.trim()}`);
        return t.stdout.trim();
      },
    }),
    // The default deps: the fixed registry and signer, never overridden.
    fetchManifest: (version) => fetchVerifiedReleaseManifest(version),
    // #815 — the lock names this execution, so a later run can break it
    // once Cloud Run says this one has ended (killed at its task timeout,
    // OOM). Outside Cloud Run there is no execution to vouch for it.
    lockState: (onBreak) =>
      acquireBucketStateLock(
        opsBucketName(placement.projectId),
        "caelo upgrader job",
        realSyncGcloud,
        {
          onBreak,
          ...(placement.execution
            ? {
                holder: {
                  execution: {
                    projectId: placement.projectId,
                    region: placement.region,
                    name: placement.execution,
                  },
                  maxRuntimeMs: UPGRADER_TASK_TIMEOUT_MINUTES * 60_000,
                },
              }
            : {}),
        },
      ),
    // Uncached on purpose: the job re-reads install.json once it holds the
    // lock to see whether another writer changed it meanwhile (#815).
    readInstall: () => {
      const text = store.peek("install.json");
      return text === null ? null : (JSON.parse(text) as InstallMetadata);
    },
    writeInstall: (meta) => store.write("install.json", meta),
    migrate: (imageRef) =>
      runMigrationsViaCloudRunJob(
        { projectId: placement.projectId, region: placement.region, imageOverride: imageRef },
        { run },
      ),
    healthProbe: (plan) => healthProbeFor(run, http, plan, { accessJustChanged: false }),
    now: () => new Date(),
    log,
  };
}
