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
 * Pure module — no I/O.
 */

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
  // The URL setter percent-encodes reserved characters, which postgres
  // clients decode again.
  parsed.password = password;
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
    const passwordVar = databasePasswordVar(urlVar);
    const password = env[passwordVar];
    return password ? withDatabasePassword(url, password, `${urlVar} (with ${passwordVar})`) : url;
  }
  return undefined;
}
