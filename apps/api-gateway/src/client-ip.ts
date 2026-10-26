// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor's address, as the infrastructure in front of the gateway
 * vouches for it.
 *
 * Every proxy on the path APPENDS to `X-Forwarded-For`; everything before
 * the entries our own infrastructure appended came from the client and can
 * be forged. So the client address is not "the first entry" (forgeable) and
 * not blindly "the last entry" either (behind a load balancer that is the
 * load balancer, for every visitor): it is the entry `hops` places from the
 * end, where `hops` is how many entries the deployment's proxies append,
 * counting the client's own. That number is a property of the topology, so
 * the provisioner sets it per provider (`CAELO_TRUSTED_PROXY_HOPS`,
 * packages/provisioning/src/stack-contract.ts `GATEWAY_TRUSTED_PROXY_HOPS`):
 *
 *   - gcp:          external Application LB appends `<client>,<LB IP>` and
 *                   the gateway's ingress is internal-and-LB only → 2.
 *   - gcp-firebase: Cloud Run's front end appends the address it got the
 *                   connection from → 1. For /api/** behind the Firebase
 *                   Hosting rewrite that address is the Hosting CDN edge,
 *                   not the visitor: the gateway is publicly invokable on
 *                   *.run.app, so any entry before it can be forged and
 *                   none may be trusted. IP-scoped buckets there are per CDN
 *                   edge address — coarse, but not rotatable.
 *   - self-hosted:  Caddy (no `trusted_proxies`) replaces the header with
 *                   the peer address; the gateway is reachable only on the
 *                   Compose network → 1.
 *   - azure:        Container Apps ingress appends the peer → 1.
 *   - 0:            nothing in front (local dev): the TCP peer address.
 *
 * Rate-limit buckets and the staging gate's IP allowlist both read the
 * address through here — one rule, not one per caller.
 */

/** The env var carrying the deployment's trusted proxy hop count. */
export const TRUSTED_PROXY_HOPS_ENV = "CAELO_TRUSTED_PROXY_HOPS";

/**
 * The gateway cannot tell who the client is: the hop count is missing or
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
 *   guessing would either pool every visitor into one rate-limit bucket or
 *   let a client pick its own.
 */
export function trustedProxyHopsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[TRUSTED_PROXY_HOPS_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new ClientAddressError(
      `${TRUSTED_PROXY_HOPS_ENV} is not set, so the API gateway cannot tell which X-Forwarded-For entry is the visitor. Cloud and self-hosted installs: run \`cms-provision upgrade\` (the provisioner sets it per provider). Local dev without a proxy: set it to 0.`,
    );
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ClientAddressError(
      `${TRUSTED_PROXY_HOPS_ENV}="${raw}" is not a non-negative integer (the number of X-Forwarded-For entries the proxies in front of the gateway append, counting the client's).`,
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
      `the request carries fewer than ${hops} X-Forwarded-For entries, but ${TRUSTED_PROXY_HOPS_ENV}=${hops} says the proxies in front of the gateway always append that many. Either a request reached the gateway around its proxy, or ${TRUSTED_PROXY_HOPS_ENV} does not match the deployment.`,
    );
  }
  return ip;
}

/**
 * Non-reversible bucket key for a client address: the rate-limit buckets
 * are keyed by it, so no raw IP lands in `gateway_rate_limit_buckets`.
 * SHA-256 hex (64 chars) — no 32-bit birthday bound between addresses.
 */
export function hashClientAddress(address: string): string {
  return new Bun.CryptoHasher("sha256").update(address).digest("hex");
}
