// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 / #1330 — which installs serve staging at its own protected
 * host, and that host.
 *
 * Staging is served by its own gateway behind the #650 gate, on every host
 * it is reached by (epic #763 E8, E11): gcp-firebase (a second Hosting
 * site rewriting everything to the staging gateway), gcp (a host rule on
 * the load balancer) and self-hosted (Caddy in front of the staging
 * gateway). Every build renders the live host; the staging gateway rewrites
 * it to the staging host while it serves, so a changed staging host needs
 * no new Stage and Publish live is a copy (#1003). aws / azure have no
 * publisher yet (#749, #750). A development checkout (no CAELO_PROVIDER)
 * keeps serving `current/` on its local staging port.
 *
 * The host is an install SETTING, not a derivation: the wizard asks for it
 * (default `staging.<domain>`), provisioning hands it to the admin as
 * `CAELO_STAGING_HOST`, the admin seeds `staging_access.staging_host` from
 * it once, and from then on the database row is the truth — the Owner (or
 * the AI through the §11.A gate) changes it with `staging_access.set_host`.
 * The seed never overwrites a stored value, so an upgrade never undoes it.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Env var with the provisioned staging host — the seed of the DB setting. */
export const STAGING_HOST_ENV = "CAELO_STAGING_HOST";

/** Env var carrying the gate's shared key (Secret Manager `staging-gate-secret`). */
export const STAGING_GATE_SECRET_ENV = "CAELO_STAGING_GATE_SECRET";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * True when `provider` serves staging through the staging gateway at its own
 * gated host (#1330). False for aws / azure (no staging gateway yet) and a
 * development checkout without CAELO_PROVIDER.
 */
export function stagingServedByGateway(provider: string | undefined): boolean {
  return provider === "gcp-firebase" || provider === "gcp" || provider === "self-hosted";
}

/** The stored staging host (`staging_access.staging_host`), or null when unset. */
export async function readStagingHost(tx: Tx): Promise<string | null> {
  const rows = (await tx.execute(
    sql`SELECT staging_host FROM staging_access WHERE id = 1`,
  )) as unknown as { staging_host: string | null }[];
  return rows[0]?.staging_host ?? null;
}

/**
 * Issue #678 — why the staging host shows nothing yet: nothing is staged.
 * (#1330: a changed staging host no longer needs a new Stage — the staging
 * gateway rewrites every build to the host as it is now.)
 */
export type StageNeeded = "nothing-staged" | null;

/** {@link StageNeeded} for whether a build is staged. */
export function stageNeededFor(hasStagedBuild: boolean): StageNeeded {
  return hasStagedBuild ? null : "nothing-staged";
}

/** The operator/AI-facing sentence for a {@link StageNeeded}, or null. */
export function describeStageNeeded(needed: StageNeeded, host: string | null): string | null {
  const where = host ? `https://${host}/` : "the staging host";
  if (needed === "nothing-staged") {
    return `Nothing is served at ${where} until the next Stage — Stage once (AI: stage_changes; admin: Stage in the editor or Open changes) to put the current published pages there.`;
  }
  return null;
}

/**
 * #1330 — the origin every build renders (`site_defaults.site_base_url`,
 * the live site's), or null while none is set (the generator then refuses
 * the build itself).
 */
export async function liveSiteOrigin(tx: Tx): Promise<string | null> {
  const rows = (await tx.execute(
    sql`SELECT site_base_url FROM site_defaults WHERE id = 1`,
  )) as unknown as { site_base_url: string | null }[];
  const url = rows[0]?.site_base_url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
  if (!stagingServedByGateway(provider)) return null;
  const host = await readStagingHost(tx);
  if (!host) {
    throw new Error(
      `No staging host is configured. A ${provider} install serves staging at its own host (default staging.<domain>), behind the staging gate. Next step: run \`cms-provision upgrade\` (it sets ${STAGING_HOST_ENV}, which the admin stores on its next start), or set the host under Settings → Domains.`,
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
