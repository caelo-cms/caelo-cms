// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — which installs serve staging at its own protected host, and
 * that host.
 *
 * On those installs a staging build renders the staging host into every
 * absolute URL and Publish live rebuilds the same content with the live
 * host behind the parity guard (build-parity.ts). Everywhere else staging
 * is built with the live host and Publish live ships the staged build as
 * it is — unchanged behaviour until the provider gets its gate:
 *
 *   gcp-firebase  the gateway proxies the staging host to the current
 *                 preview channel behind the access gate (this PR)
 *   self-hosted   Caddy already serves a staging host; its gate is the
 *                 follow-up to #650
 *   gcp           staging stays the IAP-gated admin route (follow-up)
 *   aws / azure   no publisher yet
 *
 * The host is an install SETTING, not a derivation: the wizard asks for it
 * (default `staging.<domain>`), provisioning hands it to the admin as
 * `CAELO_STAGING_HOST`, the admin seeds `staging_access.staging_host` from
 * it once, and from then on the database row is the truth — the Owner (or
 * the AI through the §11.A gate) changes it with `staging_access.set_host`.
 * On a provider with a staging domain an unset host fails loudly
 * (CLAUDE.md §2) instead of building staging with the live host.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Env var with the provisioned staging host — the seed of the DB setting. */
export const STAGING_HOST_ENV = "CAELO_STAGING_HOST";

/** Env var carrying the gate's shared key (Secret Manager `staging-gate-secret`). */
export const STAGING_GATE_SECRET_ENV = "CAELO_STAGING_GATE_SECRET";

const PROVIDERS_WITH_STAGING_DOMAIN: ReadonlySet<string> = new Set(["gcp-firebase"]);

type Env = Readonly<Record<string, string | undefined>>;

/** True when `provider` serves staging at its own gated host. */
export function providerHasStagingDomain(provider: string | undefined): boolean {
  return provider !== undefined && PROVIDERS_WITH_STAGING_DOMAIN.has(provider);
}

/** The stored staging host (`staging_access.staging_host`), or null when unset. */
export async function readStagingHost(tx: Tx): Promise<string | null> {
  const rows = (await tx.execute(
    sql`SELECT staging_host FROM staging_access WHERE id = 1`,
  )) as unknown as { staging_host: string | null }[];
  return rows[0]?.staging_host ?? null;
}

/**
 * The staging origin (`https://<staging host>`) for this install, or null
 * when its provider has no staging domain.
 *
 * @throws when the provider has one but no staging host is stored.
 */
export async function stagingSiteUrl(
  tx: Tx,
  provider: string | undefined = process.env.CAELO_PROVIDER,
): Promise<string | null> {
  if (!providerHasStagingDomain(provider)) return null;
  const host = await readStagingHost(tx);
  if (!host) {
    throw new Error(
      `No staging host is configured. A ${provider} install serves staging at its own host (default staging.<domain>), and every staging build renders it. Next step: run \`cms-provision upgrade\` (it sets ${STAGING_HOST_ENV}, which the admin stores on its next start), or set the host under Security → Domains, then Stage again.`,
    );
  }
  return `https://${host}`;
}

/**
 * Hosts the staging host must not take: the live site's (the stored base
 * URL and the provisioned site URL) and the admin's (`admin.<domain>`, and
 * the admin's own origin when the admin knows it).
 */
export async function reservedStagingHosts(
  tx: Tx,
  env: Env = process.env,
): Promise<{ liveHosts: string[]; adminHosts: string[] }> {
  const hostOf = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  const rows = (await tx.execute(
    sql`SELECT site_base_url FROM site_defaults WHERE id = 1`,
  )) as unknown as { site_base_url: string | null }[];
  const live = [hostOf(rows[0]?.site_base_url), hostOf(env.CAELO_SITE_URL)].filter(
    (h): h is string => h !== null,
  );
  const installDomain = hostOf(env.CAELO_SITE_URL);
  const admin = [installDomain ? `admin.${installDomain}` : null, hostOf(env.ORIGIN)].filter(
    (h): h is string => h !== null,
  );
  return { liveHosts: live, adminHosts: admin };
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
