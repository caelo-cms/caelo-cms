// SPDX-License-Identifier: MPL-2.0

/**
 * The AWS stack's per-service ECS task roles (#635 review): which Secrets
 * Manager entries each service's task role may read. One role per service,
 * so the API gateway's identity cannot read a secret that unlocks a
 * cms_admin login (CLAUDE.md §2: the public side has no path to cms_admin),
 * mirroring the GCP gateway SA's bindings (stack-contract.ts
 * `SERVICE_SECRET_ENV`). Kept apart from the Pulumi program so the
 * provisioning tests can assert it.
 */

/** The Secrets Manager entries the AWS stack creates (`caelo-<env>-<name>`). */
export type AwsSecret =
  | "postgres-password"
  | "public-role-password"
  | "csrf-secret"
  | "cookie-secret"
  | "anthropic-api-key"
  | "resend-api-key";

/** A service with its own ECS task role. */
export type AwsTaskService = "admin" | "gateway" | "mcp-auth-proxy";

/**
 * The secrets each service's task role may read. The admin side (admin and
 * its in-process workers) reads all of them; the gateway reads only
 * public_role's password — its one database login; the MCP-Auth-Proxy
 * (#1328) reads none: remote MCP is not available on AWS, so it holds
 * neither a database login nor the broker's keys.
 */
export const AWS_SERVICE_SECRETS: Readonly<Record<AwsTaskService, readonly AwsSecret[]>> = {
  admin: [
    "postgres-password",
    "public-role-password",
    "csrf-secret",
    "cookie-secret",
    "anthropic-api-key",
    "resend-api-key",
  ],
  gateway: ["public-role-password"],
  "mcp-auth-proxy": [],
};

/**
 * #1339 (epic #763 L5) — the database password env vars each task
 * definition sets as ECS `secrets` (Secrets Manager references), and the
 * secret each comes from. The URLs carry no password (shared
 * database-url.ts: `<NAME>_URL` + `<NAME>_PASSWORD`). Every secret named
 * here is one the service may read ({@link AWS_SERVICE_SECRETS}, asserted by
 * a test). ECS resolves `secrets` with the task's execution role, so the
 * task definitions of #749 get one execution role per service, scoped like
 * its task role.
 */
export const AWS_SERVICE_DATABASE_PASSWORDS: Readonly<
  Record<AwsTaskService, Readonly<Record<string, AwsSecret>>>
> = {
  admin: {
    ADMIN_DATABASE_PASSWORD: "postgres-password",
    PUBLIC_ADMIN_DATABASE_PASSWORD: "postgres-password",
    PUBLIC_STAGING_ADMIN_DATABASE_PASSWORD: "postgres-password",
  },
  gateway: { PUBLIC_DATABASE_PASSWORD: "public-role-password" },
  "mcp-auth-proxy": {},
};

/**
 * The IAM policy document letting a task role read exactly `secretArns`.
 *
 * @throws on an empty list: a policy with no resource is malformed, and a
 *   service that needs no secret should get no secrets policy at all.
 */
export function secretsReadPolicy(secretArns: readonly string[]): string {
  if (secretArns.length === 0) throw new Error("secretsReadPolicy: no secret ARNs");
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: [...secretArns] },
    ],
  });
}
