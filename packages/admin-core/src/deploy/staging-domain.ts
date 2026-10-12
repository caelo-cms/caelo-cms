// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — which installs serve staging at its own protected host
 * (`staging.<domain>`), and that host.
 *
 * On those installs a staging build renders the staging host into every
 * absolute URL and Publish live rebuilds the same content with the live
 * host behind the parity guard (build-parity.ts). Everywhere else staging
 * is built with the live host and Publish live ships the staged build as
 * it is — unchanged behaviour until the provider gets its gate:
 *
 *   gcp-firebase  the gateway proxies staging.<domain> to the current
 *                 preview channel behind the access gate (this PR)
 *   self-hosted   Caddy already serves staging.<domain>; its gate is the
 *                 follow-up to #650
 *   gcp           staging stays the IAP-gated admin route (follow-up)
 *   aws / azure   no publisher yet
 *
 * The host comes from `CAELO_STAGING_SITE_URL`, which provisioning sets
 * (stack-contract.ts) — the same pattern as `CAELO_SITE_URL`. On a
 * provider that has a staging domain, a missing value is a provisioning
 * error and fails loudly (CLAUDE.md §2) instead of silently building
 * staging with the live host.
 */

/** Env var carrying the staging origin, e.g. `https://staging.example.com`. */
export const STAGING_SITE_URL_ENV = "CAELO_STAGING_SITE_URL";

/** Env var carrying the gate's shared key (Secret Manager `staging-gate-secret`). */
export const STAGING_GATE_SECRET_ENV = "CAELO_STAGING_GATE_SECRET";

const PROVIDERS_WITH_STAGING_DOMAIN: ReadonlySet<string> = new Set(["gcp-firebase"]);

type Env = Readonly<Record<string, string | undefined>>;

/** True when `provider` serves staging at its own gated host. */
export function providerHasStagingDomain(provider: string | undefined): boolean {
  return provider !== undefined && PROVIDERS_WITH_STAGING_DOMAIN.has(provider);
}

/**
 * The staging origin (no trailing slash) for this install, or null when
 * its provider has no staging domain.
 *
 * @throws when the provider has one but `CAELO_STAGING_SITE_URL` is unset
 *   or not an https origin.
 */
export function stagingSiteUrl(
  provider: string | undefined = process.env.CAELO_PROVIDER,
  env: Env = process.env,
): string | null {
  if (!providerHasStagingDomain(provider)) return null;
  const raw = env[STAGING_SITE_URL_ENV];
  if (!raw) {
    throw new Error(
      `${STAGING_SITE_URL_ENV} is not set on the admin service. A ${provider} install serves staging at https://staging.<domain>, and every staging build renders that host. Next step: run \`cms-provision upgrade\` (it sets the variable), then Stage again.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${STAGING_SITE_URL_ENV}="${raw}" is not a URL; expected https://staging.<domain>`,
    );
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "") {
    throw new Error(
      `${STAGING_SITE_URL_ENV}="${raw}" must be a bare https origin (https://staging.<domain>)`,
    );
  }
  return url.origin;
}

/**
 * The gate's shared key.
 *
 * @throws when `CAELO_STAGING_GATE_SECRET` is unset, naming the fix.
 */
export function stagingGateSecret(env: Env = process.env): string {
  const secret = env[STAGING_GATE_SECRET_ENV];
  if (!secret) {
    throw new Error(
      `${STAGING_GATE_SECRET_ENV} is not set on the admin service — it signs "Open staging" links and derives the staging crawler credentials. Next step: run \`cms-provision upgrade\` (it creates the staging-gate-secret in Secret Manager and mounts it), then try again.`,
    );
  }
  return secret;
}

/** `https://staging.example.com` + `/about/` → `https://staging.example.com/about/`. */
export function stagingPageUrl(stagingOrigin: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${stagingOrigin.replace(/\/+$/, "")}${p}`;
}
