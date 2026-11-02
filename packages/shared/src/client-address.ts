// SPDX-License-Identifier: MPL-2.0

/**
 * The client's address, as the infrastructure in front of a public service
 * vouches for it — one rule for every Caelo service that faces the internet
 * (the visitor data gateway, apps/api-gateway; the MCP-Auth-Proxy,
 * apps/mcp-auth-proxy). Pure Web APIs, no runtime dependency.
 *
 * Every proxy on the path APPENDS to `X-Forwarded-For`; everything before
 * the entries our own infrastructure appended came from the client and can
 * be forged. So the client address is not "the first entry" (forgeable) and
 * not blindly "the last entry" either (behind a load balancer that is the
 * load balancer, for every client): it is the entry `hops` places from the
 * end, where `hops` is how many entries the deployment's proxies append,
 * counting the client's own. That number is a property of the topology in
 * front of each service, so the provisioner sets it per provider and service
 * (`CAELO_TRUSTED_PROXY_HOPS`, packages/provisioning/src/stack-contract.ts):
 *
 *   - gcp:          external Application LB appends `<client>,<LB IP>` and
 *                   the service's ingress is internal-and-LB only → 2.
 *   - gcp-firebase: Cloud Run's front end appends the address it got the
 *                   connection from → 1 (behind the Firebase Hosting
 *                   rewrite that is the Hosting CDN edge, see the gateway's
 *                   client-ip.ts).
 *   - self-hosted:  Caddy (no `trusted_proxies`) replaces the header with
 *                   the peer address; the service is reachable only on the
 *                   Compose network → 1.
 *   - azure:        Container Apps ingress appends the peer → 1.
 *   - 0:            nothing in front (local dev): the TCP peer address.
 *
 * The MCP-Auth-Proxy is reached the same way as the gateway on every
 * provider (on gcp-firebase directly on its run.app URL, on gcp through the
 * load balancer), so the same counts apply to it.
 */

/** The env var carrying the deployment's trusted proxy hop count. */
export const TRUSTED_PROXY_HOPS_ENV = "CAELO_TRUSTED_PROXY_HOPS";

/**
 * The service cannot tell who the client is: the hop count is missing or
 * invalid, or a request arrived with fewer forwarded entries than the
 * deployment's proxies always append. Both are deployment errors; the
 * message names the fix.
 */
export class ClientAddressError extends Error {
  override readonly name = "ClientAddressError";
}

/**
 * The trusted proxy hop count from `env`.
 *
 * @throws ClientAddressError when it is unset or not a non-negative integer —
 *   guessing would either pool every client into one rate-limit bucket or
 *   let a client pick its own.
 */
export function trustedProxyHopsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[TRUSTED_PROXY_HOPS_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new ClientAddressError(
      `${TRUSTED_PROXY_HOPS_ENV} is not set, so this service cannot tell which X-Forwarded-For entry is the client. Cloud and self-hosted installs: run \`cms-provision upgrade\` (the provisioner sets it per provider). Local dev without a proxy: set it to 0.`,
    );
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ClientAddressError(
      `${TRUSTED_PROXY_HOPS_ENV}="${raw}" is not a non-negative integer (the number of X-Forwarded-For entries the proxies in front of this service append, counting the client's).`,
    );
  }
  return Number.parseInt(raw.trim(), 10);
}

/**
 * The entry `hops` places from the end of `xForwardedFor` (1 = the last), or
 * null when the header has fewer entries than that.
 *
 * @example
 *   forwardedClientIp("6.6.6.6, 198.51.100.7, 34.1.2.3", 2) // → "198.51.100.7"
 */
export function forwardedClientIp(xForwardedFor: string | null, hops: number): string | null {
  if (hops < 1 || !xForwardedFor) return null;
  const entries = xForwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries[entries.length - hops] ?? null;
}

/**
 * The client address of `req` under `hops`.
 *
 * @param peerAddress the TCP peer (Bun `server.requestIP`); used only when
 *   `hops` is 0.
 * @throws ClientAddressError when the request does not carry what the
 *   configured topology always adds.
 */
export function clientAddress(req: Request, hops: number, peerAddress: string | null): string {
  if (hops === 0) {
    if (!peerAddress) {
      throw new ClientAddressError(
        `${TRUSTED_PROXY_HOPS_ENV}=0 (no proxy) but the connection's peer address is unknown.`,
      );
    }
    return peerAddress;
  }
  const ip = forwardedClientIp(req.headers.get("x-forwarded-for"), hops);
  if (!ip) {
    throw new ClientAddressError(
      `the request carries fewer than ${hops} X-Forwarded-For entries, but ${TRUSTED_PROXY_HOPS_ENV}=${hops} says the proxies in front of this service always append that many. Either a request reached the service around its proxy, or ${TRUSTED_PROXY_HOPS_ENV} does not match the deployment.`,
    );
  }
  return ip;
}
