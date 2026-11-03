// SPDX-License-Identifier: MPL-2.0

/**
 * Database connection URLs as every Caelo process reads them from its
 * environment.
 *
 * A URL var (`ADMIN_DATABASE_URL`, `PUBLIC_ADMIN_DATABASE_URL`,
 * `PUBLIC_DATABASE_URL`) may carry its password inline — the shape the
 * self-hosted compose stack, CI and `.env` use — or leave it out and have
 * the password come from a companion `<NAME>_PASSWORD` var
 * (`ADMIN_DATABASE_URL` → `ADMIN_DATABASE_PASSWORD`). Cloud installs use the
 * second shape: the URL (host, role, database) is a plain env var, the
 * password is a Secret Manager reference, so the password never shows up in
 * the service's configuration or its revision history.
 *
 * A URL that reaches a database on another machine must ask for
 * `sslmode=verify-full` (database-tls.ts, #1338); {@link databaseUrlFromEnv}
 * refuses one that does not.
 *
 * Pure module — no I/O.
 */

import {
  CLOUD_SQL_CA_BUNDLE,
  databaseTlsProblem,
  isIpLiteral,
  verifyFullQuery,
} from "./database-tls.js";

/** The `<NAME>_PASSWORD` var that pairs with a `<NAME>_URL` var. */
export function databasePasswordVar(urlVar: string): string {
  if (!urlVar.endsWith("_URL")) {
    throw new Error(`database URL var must end in _URL, got ${urlVar}`);
  }
  return `${urlVar.slice(0, -"_URL".length)}_PASSWORD`;
}

/**
 * Inject `password` into a password-less connection URL. Refuses a URL that
 * already carries one: two sources for the same credential is a
 * misconfiguration, and silently preferring either would hide it.
 *
 * @example
 *   withDatabasePassword("postgresql://admin_role@10.0.0.3:5432/cms_admin", "s3cr3t")
 *   // → "postgresql://admin_role:s3cr3t@10.0.0.3:5432/cms_admin"
 */
export function withDatabasePassword(
  url: string,
  password: string,
  label = "database URL",
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.password) {
    throw new Error(
      `${label} already carries a password and a separate password is set too — keep one`,
    );
  }
  if (!parsed.username) {
    throw new Error(`${label} names no user to attach the password to`);
  }
  // Encode first: the URL setter leaves a literal `%` alone, so `p%40ss`
  // would decode to `p@ss` and `p%ss` would be an invalid escape. Postgres
  // clients decode the userinfo again.
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/**
 * The connection URL from the first of `urlVars` that is set, with its
 * companion `_PASSWORD` var applied when that is set. `undefined` when none
 * of `urlVars` is set, so callers keep their own "X is required" errors.
 *
 * @param urlVars URL var names in order of preference, e.g.
 *   `["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"]`.
 * @param env The environment to read (defaults to `process.env`).
 */
export function databaseUrlFromEnv(
  urlVars: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  for (const urlVar of urlVars) {
    const url = env[urlVar];
    if (!url) continue;
    const tls = databaseTlsProblem(url, urlVar);
    if (tls) throw new Error(tls);
    const passwordVar = databasePasswordVar(urlVar);
    const password = env[passwordVar];
    return password ? withDatabasePassword(url, password, `${urlVar} (with ${passwordVar})`) : url;
  }
  return undefined;
}

/**
 * Password-less database URLs for Cloud SQL IAM database authentication —
 * how the in-cloud jobs (the operator-access sync job, the upgrader job)
 * connect: the user is the service account email without
 * `.gserviceaccount.com`, the password a short-lived OAuth access token.
 * TLS is verify-full against Google's Cloud SQL shared-CA bundle, so `host`
 * must be the instance's DNS name (its certificate names no IP).
 *
 * @example
 *   cloudSqlIamDatabaseUrls("10.0.0.3", "job@p.iam.gserviceaccount.com", "ya29.x").user
 *   // → "job@p.iam"
 */
export function cloudSqlIamDatabaseUrls(
  host: string,
  serviceAccountEmail: string,
  accessToken: string,
): { admin: string; public: string; user: string } {
  if (isIpLiteral(host)) {
    throw new Error(
      `the Cloud SQL host is the IP address ${host}, but the instance's certificate names only its DNS name, so a verify-full connection to it cannot succeed (#1338). Run the converge (\`cms-provision upgrade\`, or Install update for a cloud-setup release) — it moves the services onto the DNS name — then retry.`,
    );
  }
  return iamUrls(host, serviceAccountEmail, accessToken, verifyFullQuery(CLOUD_SQL_CA_BUNDLE));
}

/**
 * #1373 — {@link cloudSqlIamDatabaseUrls} for the instance's private IP,
 * for the one connection that dials it: the converge job's, before the
 * install's TLS step has given the instance a DNS name the clients can
 * resolve. The URLs ask for `sslmode=verify-full` and name no trust anchor;
 * the caller must pass the server checks itself (`DatabaseAdapter`'s
 * `tls`, from provisioning converge-db-trust.ts), since a certificate
 * never names an IP.
 *
 * @throws when `ip` is not an IP literal: a DNS host takes the verify-full
 *   URLs of {@link cloudSqlIamDatabaseUrls}
 */
export function cloudSqlIamIpDatabaseUrls(
  ip: string,
  serviceAccountEmail: string,
  accessToken: string,
): { admin: string; public: string; user: string } {
  if (!isIpLiteral(ip)) {
    throw new Error(
      `${ip} is a host name; connect to it with verify-full (cloudSqlIamDatabaseUrls), not with the IP-address checks`,
    );
  }
  return iamUrls(ip, serviceAccountEmail, accessToken, verifyFullQuery());
}

function iamUrls(
  host: string,
  serviceAccountEmail: string,
  accessToken: string,
  tlsQuery: string,
): { admin: string; public: string; user: string } {
  const user = serviceAccountEmail.replace(/\.gserviceaccount\.com$/, "");
  const url = (db: string) =>
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(accessToken)}@${host}:5432/${db}?${tlsQuery}`;
  return { admin: url("cms_admin"), public: url("cms_public"), user };
}
