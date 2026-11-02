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

// The rule itself is shared with the MCP-Auth-Proxy (@caelo-cms/shared
// client-address.ts); the gateway's callers keep importing it from here.
export {
  ClientAddressError,
  clientAddress,
  forwardedClientIp,
  TRUSTED_PROXY_HOPS_ENV,
  trustedProxyHopsFromEnv,
} from "@caelo-cms/shared";

/**
 * Non-reversible bucket key for a client address: the rate-limit buckets
 * are keyed by it, so no raw IP lands in `gateway_rate_limit_buckets`.
 * SHA-256 hex (64 chars) — no 32-bit birthday bound between addresses.
 */
export function hashClientAddress(address: string): string {
  return new Bun.CryptoHasher("sha256").update(address).digest("hex");
}
