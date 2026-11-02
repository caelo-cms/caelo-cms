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
import { isIpLiteral } from "@caelo-cms/shared";
import {
  ensureCloudSqlVerifyFull,
  liveDatabaseUrls,
  moveServicesToDnsHost,
} from "./cloudsql-tls.js";
import { findSqlInstance } from "./gateway-credentials.js";
import { gcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import type { InstallMetadata } from "./install-state.js";
import { readAdminConfig, runMigrationsViaCloudRunJob } from "./migration-runner.js";
import { fetchVerifiedReleaseManifest } from "./release-manifest.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { DATABASE_URL_VARS } from "./stack-contract.js";
import { liveContainerEnv } from "./stack-converge.js";
import { opsBucketName } from "./state-backend.js";
import { acquireBucketStateLock, GcsStateStore, realSyncGcloud } from "./state-store.js";
import type { AppRollPlan } from "./upgrade/app-roll.js";
import {
  describeServiceJson,
  findServiceUrl,
  resolveGcpResourceName,
} from "./upgrade/gcp-lookup.js";
import { createIapHealthProbe } from "./upgrade/health.js";
import { createReleaseImageForms } from "./upgrade/image-forms.js";
import { type IamTester, restIamTester } from "./upgrader-iam-preflight.js";
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
 * #1338 — the database host for the converge job (#819), after making sure
 * a verify-full connection to it can work. The job opens its database
 * queue before it converges anything, with this release's code, which
 * connects with verify-full only; on an install whose services still dial
 * the instance's IP it first runs the converge's database TLS step
 * (cloudsql-tls.ts: shared CA, private DNS name, services moved onto it).
 * The job runs as the install's `caelo-provisioner`, which holds
 * `roles/cloudsql.admin` and `roles/dns.admin` (gcloud.ts PROVISIONER_ROLES).
 * Idempotent: the converge's own step finds everything in shape.
 */
export async function convergeDatabaseHost(
  placement: Pick<UpgraderPlacement, "projectId" | "region">,
  run: GcloudRunner = gcloud,
  http?: HttpFetch,
): Promise<string> {
  const host = await upgraderDatabaseHost(placement, run);
  if (!isIpLiteral(host)) return host;
  const install = { projectId: placement.projectId, env: GCP_STACK_ENV };
  const lookup = await findSqlInstance(install, { run });
  if (lookup.status !== "found") {
    throw new Error(`could not find the install's Cloud SQL instance (${lookup.status})`);
  }
  const deps = { run, ...(http ? { http } : {}) };
  const tls = await ensureCloudSqlVerifyFull({ ...install, sqlInstance: lookup.name }, deps);
  if (!tls.ok) throw new Error(`database TLS could not be set up: ${tls.error}`);
  const services: { serviceName: string; liveUrls: Record<string, string> }[] = [];
  for (const slug of ["admin", "gateway"] as const) {
    const found = await resolveGcpResourceName(
      run,
      "run-service",
      `caelo-${GCP_STACK_ENV}-${slug}`,
      placement.projectId,
      placement.region,
    );
    if (found.status !== "found") throw new Error(`could not find the ${slug} service`);
    const json = await describeServiceJson(run, placement.projectId, placement.region, found.name);
    if (!json) throw new Error(`could not read the ${slug} service's configuration`);
    services.push({
      serviceName: found.name,
      liveUrls: liveDatabaseUrls(liveContainerEnv(json), DATABASE_URL_VARS[slug]),
    });
  }
  const moved = await moveServicesToDnsHost(placement, services, tls.host, deps);
  if (!moved.ok) throw new Error(moved.error);
  return tls.host;
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

/**
 * The IAM self-check's tester as this job's own account: gcloud's token from
 * the metadata server, so it sees exactly the job's grants (#818, #884).
 */
export function gcloudIamTester(run: GcloudRunner, http: HttpFetch): IamTester {
  return restIamTester({
    http,
    token: async () => {
      const t = await run(["auth", "print-access-token"]);
      if (!t.ok) throw new Error(`gcloud auth print-access-token: ${t.stderr.trim()}`);
      return t.stdout.trim();
    },
  });
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
    iam: gcloudIamTester(run, http),
    // The default deps: the fixed registry and signer, never overridden.
    fetchManifest: (version) => fetchVerifiedReleaseManifest(version),
    // #1025 — the fixed public mirror, read by digest and content-checked.
    imageForms: createReleaseImageForms(),
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
