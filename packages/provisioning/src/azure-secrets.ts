// SPDX-License-Identifier: MPL-2.0

/**
 * #1339 (epic #763 L5) — which Key Vault secret each Azure Container App
 * reads as which database password env var. The database URLs carry no
 * password (shared database-url.ts: `<NAME>_URL` + `<NAME>_PASSWORD`); the
 * password is a Key Vault reference on the app, read through a
 * user-assigned identity that holds "Key Vault Secrets User" on exactly the
 * secrets listed here. Mirrors the GCP services' Secret Manager env
 * (stack-contract.ts `SERVICE_SECRET_ENV`) and the AWS task roles
 * (aws-task-roles.ts). Kept apart from the Pulumi program so the
 * provisioning tests can assert it.
 */

/** The Key Vault secrets holding a database password (`caelo<env>-<name>`). */
export type AzureDatabaseSecret = "pg-password" | "public-role-password";

/**
 * An identity that reads secrets: `admin` for the admin-side apps (admin,
 * orchestrator, runner), `gateway` for the API gateway. The MCP-Auth-Proxy
 * reads none (#1328).
 */
export type AzureSecretReader = "admin" | "gateway";

/** Each reader's password env vars and the secret each comes from. */
export const AZURE_SERVICE_DATABASE_SECRETS: Readonly<
  Record<AzureSecretReader, Readonly<Record<string, AzureDatabaseSecret>>>
> = {
  admin: {
    ADMIN_DATABASE_PASSWORD: "pg-password",
    PUBLIC_ADMIN_DATABASE_PASSWORD: "pg-password",
    PUBLIC_STAGING_ADMIN_DATABASE_PASSWORD: "pg-password",
  },
  // CLAUDE.md §2: public_role on cms_public is the gateway's one login.
  gateway: {
    PUBLIC_DATABASE_PASSWORD: "public-role-password",
  },
};
