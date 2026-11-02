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
 *                   Hosting rewrite that address is a Google front-end
 *                   proxy, not the visitor, and it changes from request to
 *                   request (measured, docs/dev/firebase-hosting-behaviour.md):
 *                   the gateway is publicly invokable on *.run.app, so any
 *                   entry before it can be forged and none may be trusted.
 *                   IP-scoped buckets there bind almost nothing; the
 *                   binding guard on gcp-firebase has to be per-operation.
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
 * The part of `address` that names one client for rate limiting.
 *
 * An IPv4 address is one client. An IPv6 address is not: a provider hands
 * every subscriber at least a /64, and a client picks any of its 2^64
 * addresses at will, so a per-address bucket would be a fresh bucket per
 * request. The /64 prefix is the smallest unit a client cannot rotate
 * (#763 M1). IPv4-mapped IPv6 (`::ffff:198.51.100.7`, how a dual-stack
 * socket reports an IPv4 peer) is the IPv4 address it carries. A value that
 * is no IP address at all is returned as it is.
 *
 * @example
 *   rateLimitAddress("2001:db8:1:2:aaaa::1")  // → "2001:db8:1:2::/64"
 *   rateLimitAddress("::ffff:198.51.100.7")   // → "198.51.100.7"
 */
export function rateLimitAddress(address: string): string {
  const raw = address.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  // Zone ids (`fe80::1%eth0`) are local to the host and never name a client.
  const ip = raw.split("%")[0] ?? raw;
  const groups = ipv6Hextets(ip);
  if (!groups) return raw;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6] ?? 0, groups[7] ?? 0];
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** The eight hextets of an IPv6 address, or null when it is not one. */
function ipv6Hextets(ip: string): number[] | null {
  // An embedded IPv4 tail (`::ffff:198.51.100.7`) is the last two hextets.
  let text = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!parts.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return parts.map((g) => Number.parseInt(g, 16));
}

/**
 * Bucket key for a client address: HMAC-SHA256 under the gateway's current
 * IP-hash key (ip-hash-key.ts), hex. An unkeyed SHA-256 of an IPv4 address
 * is reversed by hashing all 2^32 addresses (#763 L3); without the key the
 * stored hashes name nobody, and the key rotates and is then deleted, so a
 * stored hash outlives the means to reverse it. The address is first
 * reduced to the unit a client cannot rotate ({@link rateLimitAddress}).
 */
export function hashClientAddress(address: string, key: Uint8Array): string {
  return new Bun.CryptoHasher("sha256", key).update(rateLimitAddress(address)).digest("hex");
}
