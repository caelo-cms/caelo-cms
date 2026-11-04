// SPDX-License-Identifier: MPL-2.0

/**
 * Deterministic names of the GCP resources the `gcp` and `gcp-firebase`
 * Pulumi stacks create. The stacks build these names with the helpers below
 * and `cms-provision upgrade` addresses the same resources through gcloud, so
 * the two can never disagree about which bucket, secret or service account
 * they mean.
 *
 * Only names that are fixed strings belong here. Pulumi auto-names (the
 * random suffix on Cloud Run services, backend buckets, ...) are discovered at
 * upgrade time instead.
 *
 * Pure module — the stacks import it from `dist/`, so it must not pull in
 * the CLI's dependencies.
 */

import { createHash } from "node:crypto";

/** The Pulumi stack name the wizard provisions and `upgrade` operates on. */
export const GCP_STACK_ENV = "production";

/** Account id of the service account external MCP clients sign as (issue #37). */
export const MCP_IAP_SERVICE_ACCOUNT_ID = "caelo-mcp";

/** Email of the MCP service account in `projectId`. */
export function mcpIapServiceAccountEmail(projectId: string): string {
  return `${MCP_IAP_SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}

/** `caelo-<env>`: prefix of every stack resource name. */
export function gcpNamePrefix(env: string): string {
  return `caelo-${env}`;
}

/** Account id of the runtime service account admin + gateway run as. */
export function runServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-run-sa`;
}

/** Email of the runtime service account admin + gateway run as. */
export function runServiceAccountEmail(projectId: string, env: string): string {
  return `${runServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * Account id of the service account the gateway runs as. Separate from the
 * admin's so the public-facing gateway can read only the secrets it needs
 * (stack-contract.ts `SERVICE_SECRET_ENV`), never the KEK or the admin-only
 * secrets.
 */
export function gatewayServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-gateway-sa`;
}

/** Email of the service account the gateway runs as. */
export function gatewayServiceAccountEmail(projectId: string, env: string): string {
  return `${gatewayServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * #1328 — account id of the service account the MCP-Auth-Proxy runs as. It
 * may read the Google sign-in client and the broker's seal key and nothing
 * else: no database password, no project role (stack-contract.ts
 * `SERVICE_SECRET_ENV` / `SERVICE_SECRET_FILES`). Shortened from the
 * service's name: account ids max out at 30 characters.
 */
export function mcpAuthProxyServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-mcp-proxy-sa`;
}

/**
 * #1328 — the `gcp` MCP-Auth-Proxy's load-balancer resources, CLI-owned
 * (remote-mcp.ts ensureRemoteMcpEdge): its serverless NEG, its backend
 * service and its own Cloud Armor policy. None matches a prefix the other
 * lookups use (`…-waf`, `…-admin-backend`, `…-gateway-backend`).
 */
export function mcpAuthProxyEdgeNames(env: string): {
  readonly neg: string;
  readonly backend: string;
  readonly policy: string;
} {
  const prefix = `${gcpNamePrefix(env)}-mcp-auth-proxy`;
  return { neg: `${prefix}-neg`, backend: `${prefix}-backend`, policy: `${prefix}-armor` };
}

/** Email of the service account the MCP-Auth-Proxy runs as. */
export function mcpAuthProxyServiceAccountEmail(projectId: string, env: string): string {
  return `${mcpAuthProxyServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * #1330 — account id of the service account the staging gateway runs as. It
 * may read the staging database's login password and the staging bucket,
 * and nothing else: no live data, no media, no gate key (the gate key
 * reaches it through the staging projection). Shortened: account ids max
 * out at 30 characters (`caelo-production-stg-gateway-sa` would be 31).
 */
export function stagingGatewayServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-stg-gw-sa`;
}

/** Email of the service account the staging gateway runs as. */
export function stagingGatewayServiceAccountEmail(projectId: string, env: string): string {
  return `${stagingGatewayServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * #1330 — the `gcp` staging gateway's load-balancer resources, CLI-owned
 * (staging-gateway-setup.ts): its serverless NEG, its backend service and
 * the managed certificate for the staging host. None matches a prefix the
 * other lookups use (`…-waf`, `…-admin-backend`, `…-gateway-backend`,
 * `…-mcp-auth-proxy-*`).
 */
export function stagingGatewayEdgeNames(env: string): {
  readonly neg: string;
  readonly backend: string;
  readonly cert: string;
  readonly pathMatcher: string;
} {
  const prefix = `${gcpNamePrefix(env)}-staging-gateway`;
  return {
    neg: `${prefix}-neg`,
    backend: `${prefix}-backend`,
    cert: `${gcpNamePrefix(env)}-staging-cert`,
    pathMatcher: "staging",
  };
}

/**
 * #1330 — the second Firebase Hosting site of a `gcp-firebase` install,
 * which serves the staging host through a `**` rewrite to the staging
 * gateway (E13 a of #763). Derived from the live site's id (Hosting site ids
 * are global, and the live one carries a random suffix): `caelo-<env>-stg-`
 * plus six hex characters of its SHA-256, so the admin and the converge,
 * which both know the live site id (`CAELO_FIREBASE_SITE`), name the same
 * site without storing it anywhere.
 */
export function firebaseStagingSiteId(env: string, liveSiteId: string): string {
  return `${gcpNamePrefix(env)}-stg-${createHash("sha256").update(liveSiteId).digest("hex").slice(0, 6)}`;
}

/**
 * Account id of the `gcp` stack's static-publisher service account. Account
 * ids max out at 30 chars, so the env is shortened.
 */
export function staticPublisherServiceAccountId(env: string): string {
  const short = env === "production" ? "prod" : env === "staging" ? "stg" : "dev";
  return `caelo-${short}-publisher`;
}

/** Globally unique GCS bucket name the stacks give each bucket. */
export function gcpBucketName(
  projectId: string,
  env: string,
  bucket: "media" | "static" | "staging" | "audit-results" | "capture",
): string {
  return `${projectId}-${gcpNamePrefix(env)}-${bucket}`;
}

/** Secret Manager secret id for one of the stack's runtime secrets. */
export function gcpSecretId(env: string, name: string): string {
  return `${gcpNamePrefix(env)}-${name}`;
}

/** Cloud Run job that keeps Google IAP operator access in sync (operator-access.ts). */
export function operatorAccessJobName(env: string): string {
  return `${gcpNamePrefix(env)}-operator-access-sync`;
}

/** Full resource name of the operator-access sync job, as the admin's env carries it. */
export function operatorAccessJobResource(projectId: string, region: string, env: string): string {
  return `projects/${projectId}/locations/${region}/jobs/${operatorAccessJobName(env)}`;
}

/**
 * Account id of the sync job's own service account — the only principal that
 * may change the admin's IAP binding and the caelo-mcp token-creator binding.
 */
export function operatorAccessServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-opaccess`;
}

/** Email of the sync job's service account. */
export function operatorAccessServiceAccountEmail(projectId: string, env: string): string {
  return `${operatorAccessServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/** Cloud Scheduler job that runs the sync job hourly (self-healing). */
export function operatorAccessScheduleName(env: string): string {
  return `${gcpNamePrefix(env)}-operator-access-hourly`;
}

/**
 * Cloud Run job that installs Caelo releases from the admin (epic #696):
 * the admin may only start it, without overrides (upgrader-setup.ts).
 */
export function upgraderJobName(env: string): string {
  return `${gcpNamePrefix(env)}-upgrader`;
}

/** Full resource name of the upgrader job, as the admin's env carries it. */
export function upgraderJobResource(projectId: string, region: string, env: string): string {
  return `projects/${projectId}/locations/${region}/jobs/${upgraderJobName(env)}`;
}

/**
 * Cloud Run job that installs releases which change the cloud setup (#819):
 * a one-shot job from the signed caelo-ops image that runs as the install's
 * `caelo-provisioner` account. The admin may only start it, without
 * overrides (converge-job-setup.ts).
 */
export function convergeJobName(env: string): string {
  return `${gcpNamePrefix(env)}-converge`;
}

/** Full resource name of the converge job, as the admin's env carries it. */
export function convergeJobResource(projectId: string, region: string, env: string): string {
  return `projects/${projectId}/locations/${region}/jobs/${convergeJobName(env)}`;
}

/**
 * #875 — Cloud Run job that runs the quality audit's Lighthouse runs in
 * parallel, one task per run (audit-job-setup.ts).
 */
export function auditJobName(env: string): string {
  return `${gcpNamePrefix(env)}-audit`;
}

/** Full resource name of the audit job, as the admin's env carries it. */
export function auditJobResource(projectId: string, region: string, env: string): string {
  return `projects/${projectId}/locations/${region}/jobs/${auditJobName(env)}`;
}

/**
 * Account id of the audit job's own service account: reads the staged
 * build, creates audit results, writes logs — nothing else
 * (audit-job-setup.ts).
 */
export function auditServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-audit`;
}

/** Email of the audit job's service account. */
export function auditServiceAccountEmail(projectId: string, env: string): string {
  return `${auditServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * #1217 — Cloud Run job that runs every server-side browser render
 * (screenshots, rendered HTML) of the install, one execution per render, so
 * no Chromium runs in the admin (capture-job-setup.ts).
 */
export function captureJobName(env: string): string {
  return `${gcpNamePrefix(env)}-capture`;
}

/** Full resource name of the capture job, as the admin's env carries it. */
export function captureJobResource(projectId: string, region: string, env: string): string {
  return `projects/${projectId}/locations/${region}/jobs/${captureJobName(env)}`;
}

/**
 * Account id of the capture job's own service account: creates capture
 * results and writes logs — nothing else; it reads only through the signed
 * URLs the admin hands it (capture-job-setup.ts).
 */
export function captureServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-capture`;
}

/** Email of the capture job's service account. */
export function captureServiceAccountEmail(projectId: string, env: string): string {
  return `${captureServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * #1140 — account id of the scheduler tick's service account: signs its own
 * IAP credential and calls the admin's tick endpoint, nothing else
 * (scheduler-setup.ts). `caelo-production-scheduler` is 26 of the 30
 * characters an account id may have.
 */
export function schedulerServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-scheduler`;
}

/** Email of the scheduler tick's service account. */
export function schedulerServiceAccountEmail(projectId: string, env: string): string {
  return `${schedulerServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/** #1140 — the Cloud Workflows workflow one scheduler tick runs (scheduler-setup.ts). */
export function schedulerWorkflowName(env: string): string {
  return `${gcpNamePrefix(env)}-scheduler-tick`;
}

/** #1140 — the Cloud Scheduler job that starts the tick workflow every N minutes. */
export function schedulerJobName(env: string): string {
  return `${gcpNamePrefix(env)}-scheduler-tick`;
}

/**
 * Account id of the upgrader job's own service account: may roll the two
 * Cloud Run services, run the migration job and back up Cloud SQL, never
 * change IAM, service accounts or secrets (upgrader-setup.ts).
 */
export function upgraderServiceAccountId(env: string): string {
  return `${gcpNamePrefix(env)}-upgrader`;
}

/** Email of the upgrader job's service account. */
export function upgraderServiceAccountEmail(projectId: string, env: string): string {
  return `${upgraderServiceAccountId(env)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * #587 — id of the project custom role that lets the admin write the
 * redirect rules into the `gcp` stack's URL map (url-map-redirects.ts).
 * Role ids allow letters, digits, `_` and `.`.
 */
export function urlMapRedirectsRoleId(env: string): string {
  return `caelo_${env.replace(/[^A-Za-z0-9]/g, "_")}_urlMapRedirects`;
}

/**
 * #587 — permissions of {@link urlMapRedirectsRoleId}: read-modify-write of
 * the URL map and waiting for the operation. A URL-map update must be
 * allowed to "use" every backend the map references, hence the `.use` pair.
 */
export const URL_MAP_REDIRECTS_PERMISSIONS: readonly string[] = [
  "compute.urlMaps.list",
  "compute.urlMaps.get",
  "compute.urlMaps.update",
  "compute.backendBuckets.use",
  "compute.backendServices.use",
  "compute.globalOperations.get",
];
