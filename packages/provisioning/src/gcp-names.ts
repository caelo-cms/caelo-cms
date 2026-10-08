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
  bucket: "media" | "static" | "staging",
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
