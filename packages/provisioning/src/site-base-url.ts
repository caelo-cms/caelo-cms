// SPDX-License-Identifier: MPL-2.0

/**
 * The install's public site URL, handed to the admin service as an env
 * var. The admin seeds `site_defaults.site_base_url` from it (canonical,
 * og:url, JSON-LD, sitemap, robots.txt `Sitemap:`) while that setting
 * still holds the dev default `http://localhost:8082`, and the static
 * generator refuses to build a public install whose base URL is local.
 *
 * Must match `SITE_BASE_URL_ENV` in `@caelo-cms/shared` (the admin side);
 * this package is published standalone and does not depend on it.
 */
export const SITE_BASE_URL_ENV = "CAELO_SITE_BASE_URL";

/** Public site URL for an install's apex domain — every stack serves it over TLS. */
export function siteBaseUrlForDomain(domain: string): string {
  return `https://${domain}`;
}

/**
 * `gcloud run services update` arguments that set env vars on the admin
 * service. One `--update-env-vars` flag carries every pair (gcloud keeps
 * only the last of repeated flags); values must not contain commas.
 */
export function adminEnvUpdateArgs(env: ReadonlyArray<readonly [string, string]>): string[] {
  if (env.length === 0) return [];
  for (const [key, value] of env) {
    if (value.includes(",")) {
      throw new Error(`adminEnvUpdateArgs: value for ${key} contains a comma: ${value}`);
    }
  }
  return [`--update-env-vars=${env.map(([k, v]) => `${k}=${v}`).join(",")}`];
}
