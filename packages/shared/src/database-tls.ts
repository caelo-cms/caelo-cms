// SPDX-License-Identifier: MPL-2.0

/**
 * TLS of every database connection (#1338, gateway hardening L6).
 *
 * Every connection to a database on another machine uses
 * `sslmode=verify-full`: the server's certificate must chain to a CA the
 * install trusts AND name the host the client dialled. `sslmode=require`
 * (what every provider used before) encrypts but checks neither, so anyone
 * who can answer on the database's address can read the passwords and the
 * data. There is no weaker mode for a remote host and no automatic downgrade
 * (CLAUDE.md §2, no fallbacks): a URL that asks for less is refused with
 * {@link databaseTlsProblem} wherever a process reads one from its
 * environment (`databaseUrlFromEnv`).
 *
 * Which CA each provider's server presents, and so which bundle the client
 * passes as `sslrootcert`:
 *
 *   - gcp / gcp-firebase: Cloud SQL with the shared CA
 *     (`GOOGLE_MANAGED_CAS_CA`); its server certificate names the instance's
 *     DNS name, not its IP, so clients dial that name (resolved by a private
 *     Cloud DNS zone in the install's VPC) and trust Google's published root
 *     + regional bundle ({@link CLOUD_SQL_CA_BUNDLE}).
 *   - aws: RDS, the endpoint host name, Amazon's RDS bundle
 *     ({@link AWS_RDS_CA_BUNDLE}).
 *   - azure: Flexible Server, the server's FQDN; its certificate chains to
 *     public roots (DigiCert Global Root G2 / Microsoft RSA Root CA 2017)
 *     that Bun trusts out of the box, so no `sslrootcert`.
 *   - self-hosted: the compose Postgres serves a certificate for the host
 *     name `postgres`, signed by a CA the installer generates once per
 *     install ({@link SELF_HOSTED_CA_FILE}).
 *
 * The bundles ship in every image at {@link DATABASE_CA_DIR}
 * (packages/shared/certs/ in the repo), so a URL built on the operator's
 * machine names a path that exists in the container.
 *
 * Pure module — no I/O.
 */

/** Where every Caelo image carries the database CA bundles (copied from packages/shared/certs/). */
export const DATABASE_CA_DIR = "/etc/caelo/db-ca";

/** Google's Cloud SQL shared-CA bundle (all regions), `cloudsql-ca-bundles/global.pem`. */
export const CLOUD_SQL_CA_BUNDLE = `${DATABASE_CA_DIR}/cloudsql-global.pem`;

/** Amazon's RDS bundle (all regions), `truststore.pki.rds.amazonaws.com/global/global-bundle.pem`. */
export const AWS_RDS_CA_BUNDLE = `${DATABASE_CA_DIR}/aws-rds-global.pem`;

/** The self-hosted install's own CA, mounted read-only into every container that connects. */
export const SELF_HOSTED_CA_FILE = `${DATABASE_CA_DIR}/self-hosted-ca.pem`;

/**
 * The query string of a verify-full connection, with `caFile` as the trust
 * anchor (omit it for a server whose chain ends in a public root).
 *
 * @example
 *   verifyFullQuery(CLOUD_SQL_CA_BUNDLE)
 *   // → "sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem"
 */
export function verifyFullQuery(caFile?: string): string {
  return caFile ? `sslmode=verify-full&sslrootcert=${caFile}` : "sslmode=verify-full";
}

/** Whether `host` is an IPv4 or IPv6 literal (with or without URL brackets). */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:.]+$/i.test(h));
}

/**
 * Hosts on this machine: a connection to them never crosses a network, so
 * dev, CI and the test suites connect without TLS.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Why `url` may not be used to reach a database, or null when it may: a
 * remote host needs `sslmode=verify-full`. Loopback hosts and unix sockets
 * (`?host=/path`) are exempt. The message names the variable and the fix.
 *
 * @param label how the URL is known to the operator, e.g. `ADMIN_DATABASE_URL`
 */
export function databaseTlsProblem(url: string, label = "database URL"): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${label} is not a valid URL`;
  }
  const socket = parsed.searchParams.get("host");
  if (socket?.startsWith("/")) return null;
  if (parsed.hostname === "" || isLoopbackHost(parsed.hostname)) return null;
  const mode = parsed.searchParams.get("sslmode");
  if (mode === "verify-full") return null;
  return `${label} reaches ${parsed.hostname} with sslmode=${mode ?? "(none)"}; every connection to a database on another machine must use sslmode=verify-full, which checks the server's certificate and host name (#1338). Cloud and self-hosted installs: run \`cms-provision upgrade\` (it sets the URLs and the database's certificate up). Local development: connect to localhost.`;
}
