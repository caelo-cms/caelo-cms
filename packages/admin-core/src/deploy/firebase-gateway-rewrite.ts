// SPDX-License-Identifier: MPL-2.0

/**
 * The `/api/**` rewrite of a Firebase Hosting version: visitor writes
 * (forms, comments, ratings) go to the install's public data gateway.
 *
 * A version is immutable, so every Caelo path that changes what a channel
 * serves without a build — the redirect sync (#1157), the plugin-data
 * release (#1155), promote and rollback — creates a NEW version from the
 * config of one that already exists. That old config names the gateway
 * service of its day. #1328 moved the gateway on gcp-firebase from the
 * service that is now the MCP-Auth-Proxy to `caelo-<env>-data-gateway`, and
 * the converge retired the admin's `run.viewer` on the old service. Copied
 * verbatim, the old rewrite then (a) makes Hosting refuse the new version
 * (it checks `run.services.get` on every rewrite target at version create)
 * and (b) would keep sending visitors' `/api/**` to the proxy. So every
 * clone passes through {@link withCurrentGatewayRewrite}: the rewrite always
 * names the gateway the admin's env names now, everything else is kept.
 */

/** Hosting's glob for the gateway rewrite (the one Caelo writes). */
export const GATEWAY_REWRITE_GLOB = "/api/**";

/** A Cloud Run rewrite as Hosting stores it. */
export interface FirebaseGatewayRewrite {
  readonly glob: string;
  readonly run: { readonly serviceId: string; readonly region: string };
}

/**
 * The `/api/**` rewrite to the gateway the admin's env names
 * (`CAELO_GATEWAY_SERVICE` / `CAELO_GATEWAY_REGION`, set by the gcp-firebase
 * stack and the converge). No fallback (CLAUDE.md §2): without them the
 * stack is misconfigured, and a version without the rewrite would 404 every
 * visitor write.
 *
 * @throws Error naming the missing env vars.
 */
export function currentGatewayRewrite(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FirebaseGatewayRewrite {
  const serviceId = env.CAELO_GATEWAY_SERVICE;
  const region = env.CAELO_GATEWAY_REGION;
  if (!serviceId || !region) {
    throw new Error(
      "static-publisher-firebase: CAELO_GATEWAY_SERVICE / CAELO_GATEWAY_REGION not set. The gcp-firebase Pulumi stack must set these env vars on the admin Cloud Run service; run `cms-provision upgrade` to restore them.",
    );
  }
  return { glob: GATEWAY_REWRITE_GLOB, run: { serviceId, region } };
}

function isGatewayRewrite(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { glob?: unknown }).glob === GATEWAY_REWRITE_GLOB &&
    typeof (entry as { run?: unknown }).run === "object"
  );
}

/**
 * Return `config` with its `/api/**` Cloud Run rewrite replaced by
 * {@link currentGatewayRewrite}, at the same position (Hosting applies the
 * first matching rewrite). A config without one gets it first. Every other
 * field and every other rewrite is kept verbatim.
 *
 * @throws Error when the gateway env vars are missing (see currentGatewayRewrite).
 */
export function withCurrentGatewayRewrite<T extends { readonly [field: string]: unknown }>(
  config: T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T & { rewrites: unknown[] } {
  const current = currentGatewayRewrite(env);
  const existing = Array.isArray(config.rewrites) ? (config.rewrites as unknown[]) : [];
  const at = existing.findIndex(isGatewayRewrite);
  const rewrites =
    at === -1
      ? [current, ...existing]
      : existing.flatMap((entry, i) => {
          if (i === at) return [current];
          // A second gateway rewrite would be dead (first match wins) and
          // could still name a service the admin may no longer read.
          return isGatewayRewrite(entry) ? [] : [entry];
        });
  return { ...config, rewrites };
}

/**
 * True when `config` already sends `/api/**` to the current gateway — the
 * redirect sync uses it to tell "nothing to release" from "the redirects
 * match but the rewrite is stale".
 */
export function hasCurrentGatewayRewrite(
  config: { readonly [field: string]: unknown },
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const current = currentGatewayRewrite(env);
  const rewrites = Array.isArray(config.rewrites) ? (config.rewrites as unknown[]) : [];
  const gateway = rewrites.filter(isGatewayRewrite) as FirebaseGatewayRewrite[];
  return (
    gateway.length === 1 &&
    gateway[0]?.run.serviceId === current.run.serviceId &&
    gateway[0]?.run.region === current.run.region
  );
}
