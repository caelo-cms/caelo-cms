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
  | "gateway-role-password"
  | "csrf-secret"
  | "cookie-secret"
  | "anthropic-api-key"
  | "resend-api-key";

/** A service with its own ECS task role. */
export type AwsTaskService = "admin" | "gateway";

/**
 * The secrets each service's task role may read. The admin side (admin and
 * its in-process workers) reads all of them; the gateway reads only
 * public_role's password — its one database login.
 */
export const AWS_SERVICE_SECRETS: Readonly<Record<AwsTaskService, readonly AwsSecret[]>> = {
  admin: [
    "postgres-password",
    "public-role-password",
    "gateway-role-password",
    "csrf-secret",
    "cookie-secret",
    "anthropic-api-key",
    "resend-api-key",
  ],
  gateway: ["public-role-password"],
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
