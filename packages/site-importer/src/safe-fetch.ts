// SPDX-License-Identifier: MPL-2.0

/**
 * issue #191 — SSRF guard for every operator/AI-supplied external URL.
 *
 * On the reference deployment (CLAUDE.md §11.B) the admin process runs
 * inside the VPC next to the private-IP database and the cloud metadata
 * endpoint — a pasted URL that resolves to a private address is exactly
 * the attack the private-network posture exists to prevent, and the
 * Owner-approval gate cannot catch it (nobody recognises a rebinding
 * hostname by eye).
 *
 * Design, in one sentence: the private-address check runs INSIDE the
 * socket's DNS lookup (`node:http(s)` agent `lookup` option), so there
 * is no gap between "we validated the name" and "we connected to it" —
 * a resolver that returns a public address first and a private one
 * second (DNS rebinding) still cannot steer the connection, because
 * every resolution the connection performs is itself the validation.
 *
 * Redirects are followed manually and every hop re-runs the full check.
 * `allowedHosts` is the ONLY exemption — an explicit, per-call,
 * exact-hostname list for test fixtures and self-hosted setups that
 * intentionally crawl a private address. There is no env-var global
 * off-switch here; callers that want one must wire it visibly.
 */

import { lookup as dnsLookup } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/** Machine-readable code so callers can branch without string-matching. */
export const EXTERNAL_URL_BLOCKED = "ExternalUrlBlocked" as const;

/**
 * Thrown (never returned) when a URL, a redirect hop, or a DNS
 * resolution lands on a non-public target. The message is written for
 * the AI/operator surface: it names the URL, the reason, and — when
 * DNS was involved — the resolved address, so "why was this blocked?"
 * never needs a debugger.
 */
export class ExternalUrlBlockedError extends Error {
  readonly code = EXTERNAL_URL_BLOCKED;
  readonly url: string;
  readonly reason: string;
  readonly resolvedAddress: string | undefined;

  constructor(url: string, reason: string, resolvedAddress?: string) {
    super(
      `External URL blocked: ${url} — ${reason}${
        resolvedAddress ? ` (resolved to ${resolvedAddress})` : ""
      }. Only public http(s) URLs on default ports can be fetched.`,
    );
    this.name = "ExternalUrlBlockedError";
    this.url = url;
    this.reason = reason;
    this.resolvedAddress = resolvedAddress;
  }
}

/** True when `err` is (or wraps, via node socket plumbing) a block. */
export function isExternalUrlBlockedError(err: unknown): err is ExternalUrlBlockedError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === EXTERNAL_URL_BLOCKED
  );
}

/**
 * Is `ip` a publicly routable unicast address? Pure + total: unknown
 * shapes return false (blocked), never throw. Covers the RFC special
 * ranges an SSRF cares about — loopback, RFC1918, CGNAT, link-local
 * (cloud metadata lives at 169.254.169.254), multicast, reserved,
 * documentation nets, and their IPv6 counterparts including
 * v4-mapped/NAT64 embeddings (validated against the embedded v4).
 */
export function isPublicIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return false;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

/**
 * Expand an IPv6 literal into its 8 16-bit groups, or null when the
 * shape is invalid. Handles `::` compression and a trailing embedded
 * IPv4 (`::ffff:127.0.0.1`). Linear string handling, no regex.
 */
function expandIpv6Groups(ip: string): number[] | null {
  let s = ip;
  // Zone index (fe80::1%eth0) — strip; the prefix check governs.
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);

  // Embedded IPv4 tail → two trailing groups.
  let v4Tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const v4 = s.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    const o = v4.split(".").map(Number);
    const o0 = o[0] ?? 0;
    const o1 = o[1] ?? 0;
    const o2 = o[2] ?? 0;
    const o3 = o[3] ?? 0;
    v4Tail = [(o0 << 8) | o1, (o2 << 8) | o3];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1); // drop the trailing ':'
  }

  const doubleAt = s.indexOf("::");
  let headParts: string[];
  let tailParts: string[];
  if (doubleAt !== -1) {
    if (s.indexOf("::", doubleAt + 1) !== -1) return null; // second '::'
    headParts = s.slice(0, doubleAt) === "" ? [] : s.slice(0, doubleAt).split(":");
    tailParts = s.slice(doubleAt + 2) === "" ? [] : s.slice(doubleAt + 2).split(":");
  } else {
    headParts = s === "" ? [] : s.split(":");
    tailParts = [];
  }

  const parseGroup = (g: string): number | null => {
    if (g.length === 0 || g.length > 4) return null;
    const n = Number.parseInt(g, 16);
    return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : null;
  };
  const head: number[] = [];
  for (const g of headParts) {
    const n = parseGroup(g);
    if (n === null) return null;
    head.push(n);
  }
  const tail: number[] = [];
  for (const g of tailParts) {
    const n = parseGroup(g);
    if (n === null) return null;
    tail.push(n);
  }
  if (v4Tail) tail.push(...v4Tail);

  const filled = 8 - head.length - tail.length;
  if (doubleAt === -1 && filled !== 0) return null;
  if (filled < 0) return null;
  return [...head, ...Array(filled).fill(0), ...tail];
}

function isPublicIpv6(ip: string): boolean {
  const g = expandIpv6Groups(ip);
  if (!g || g.length !== 8) return false;
  const g0 = g[0] ?? 0;
  const g1 = g[1] ?? 0;
  const allZeroHead = g.slice(0, 5).every((x) => x === 0);

  // :: (unspecified) and ::1 (loopback)
  if (g.every((x) => x === 0)) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false;
  // v4-mapped ::ffff:a.b.c.d and v4-compatible ::a.b.c.d → judge the v4
  if (allZeroHead && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicIpv4(groupsToV4(g[6] ?? 0, g[7] ?? 0));
  }
  // NAT64 64:ff9b::/96 → judge the embedded v4
  if (g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicIpv4(groupsToV4(g[6] ?? 0, g[7] ?? 0));
  }
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  return true;
}

function groupsToV4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export interface SafeFetchOptions {
  /**
   * Exact hostnames (case-insensitive) exempt from the public-address
   * and default-port checks. Scoped escape hatch for test fixtures and
   * deliberate private-network crawls — never a pattern, never global.
   */
  readonly allowedHosts?: readonly string[];
  readonly headers?: Record<string, string>;
  /** Redirect hops to follow (each re-validated). Default 3. */
  readonly maxRedirects?: number;
  /** Response size cap; exceeding it ABORTS (no silent truncation). Default 5 MiB. */
  readonly maxBytes?: number;
  /** Per-request wall-clock cap. Default 20s. */
  readonly timeoutMs?: number;
  /**
   * DNS override for tests: must behave like `dns.lookup` with
   * `{ all: true }` — resolve to every address the name has.
   */
  readonly lookupFn?: (
    hostname: string,
  ) => Promise<ReadonlyArray<{ address: string; family: number }>>;
}

export interface SafeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string;
  /** Body decoded as UTF-8. Callers gate on contentType before trusting it. */
  readonly bodyText: string;
  /** URL after redirects — callers enforce their own same-host policies on it. */
  readonly finalUrl: string;
}

/** Binary twin of {@link SafeFetchResponse} — raw bytes, no decode. */
export interface SafeFetchBinaryResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string;
  /** Raw response bytes. Callers gate on contentType before trusting them. */
  readonly bodyBytes: Uint8Array;
  /** URL after redirects — callers enforce their own same-host policies on it. */
  readonly finalUrl: string;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return allowedHosts.some((a) => a.toLowerCase() === h);
}

/**
 * Parse + statically validate a URL before any network I/O: scheme,
 * port, IP-literal hostnames, and the localhost family. DNS-dependent
 * names pass here and get caught by the guarded lookup at connect time.
 * Returns the parsed URL; throws ExternalUrlBlockedError otherwise.
 */
export function assertPublicHttpUrl(rawUrl: string, opts?: SafeFetchOptions): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ExternalUrlBlockedError(rawUrl, "not a parseable absolute URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ExternalUrlBlockedError(rawUrl, `scheme ${u.protocol} is not allowed`);
  }
  const allowed = opts?.allowedHosts ?? [];
  // WHATWG hostnames keep IPv6 brackets; strip for isIP.
  const bareHost = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (isAllowedHost(bareHost, allowed) || isAllowedHost(u.hostname, allowed)) return u;

  if (u.port !== "") {
    throw new ExternalUrlBlockedError(rawUrl, `non-default port ${u.port} is not allowed`);
  }
  if (bareHost === "localhost" || bareHost.endsWith(".localhost")) {
    throw new ExternalUrlBlockedError(rawUrl, "localhost is not a public host");
  }
  if (isIP(bareHost) !== 0 && !isPublicIpAddress(bareHost)) {
    throw new ExternalUrlBlockedError(rawUrl, "IP literal is not publicly routable", bareHost);
  }
  return u;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * Build the `lookup` implementation handed to the http(s) agent. Every
 * resolution the socket performs funnels through here; if ANY resolved
 * address is non-public the connection is refused — a name that
 * resolves to a mixed public/private set is treated as hostile rather
 * than "use the public one".
 */
function makeGuardedLookup(rawUrl: string, opts?: SafeFetchOptions) {
  const allowed = opts?.allowedHosts ?? [];
  return (hostname: string, options: unknown, callback: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const lookupOpts = (typeof options === "object" && options !== null ? options : {}) as {
      all?: boolean;
      family?: number;
    };
    const resolveAll = opts?.lookupFn
      ? opts.lookupFn(hostname)
      : new Promise<ReadonlyArray<{ address: string; family: number }>>((resolve, reject) => {
          dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses as ReadonlyArray<{ address: string; family: number }>);
          });
        });
    resolveAll
      .then((addresses) => {
        if (addresses.length === 0) {
          cb(Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" }), "");
          return;
        }
        if (!isAllowedHost(hostname, allowed)) {
          const bad = addresses.find((a) => !isPublicIpAddress(a.address));
          if (bad) {
            cb(
              new ExternalUrlBlockedError(
                rawUrl,
                `hostname ${hostname} resolves to a non-public address`,
                bad.address,
              ) as unknown as NodeJS.ErrnoException,
              "",
            );
            return;
          }
        }
        const wanted =
          lookupOpts.family === 4 || lookupOpts.family === 6
            ? addresses.filter((a) => a.family === lookupOpts.family)
            : addresses;
        const usable = wanted.length > 0 ? wanted : addresses;
        if (lookupOpts.all) {
          cb(null, [...usable]);
        } else {
          const first = usable[0];
          if (!first) {
            cb(Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" }), "");
            return;
          }
          cb(null, first.address, first.family);
        }
      })
      .catch((err) => cb(err as NodeJS.ErrnoException, ""));
  };
}

/**
 * GET a public external URL with connect-time SSRF validation, manual
 * re-validated redirects, a byte cap, and a deadline. Throws
 * ExternalUrlBlockedError for policy blocks and plain Errors for
 * network failures — callers that need to distinguish use
 * `isExternalUrlBlockedError`.
 */
export async function safeExternalFetch(
  rawUrl: string,
  opts?: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  const res = await fetchWithRedirects(rawUrl, opts);
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.contentType,
    bodyText: Buffer.from(res.bodyBytes).toString("utf8"),
    finalUrl: res.finalUrl,
  };
}

/**
 * issue #249 — same guard, same redirect policy, same caps as
 * {@link safeExternalFetch}, but the body stays raw bytes. Media
 * migration downloads images/fonts/PDFs where a UTF-8 round-trip
 * would corrupt the payload.
 */
export async function safeExternalFetchBinary(
  rawUrl: string,
  opts?: SafeFetchOptions,
): Promise<SafeFetchBinaryResponse> {
  return fetchWithRedirects(rawUrl, opts);
}

/** Shared redirect loop — every hop re-runs the full SSRF validation. */
async function fetchWithRedirects(
  rawUrl: string,
  opts?: SafeFetchOptions,
): Promise<SafeFetchBinaryResponse> {
  const maxRedirects = opts?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = assertPublicHttpUrl(current, opts);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`safeExternalFetch timed out fetching ${rawUrl}`);
    const res = await requestOnce(u, current, remaining, maxBytes, opts);
    if (res.redirectTo !== null) {
      current = new URL(res.redirectTo, u).toString();
      continue;
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      contentType: res.contentType,
      bodyBytes: res.bodyBytes,
      finalUrl: current,
    };
  }
  throw new ExternalUrlBlockedError(rawUrl, `more than ${maxRedirects} redirects`);
}

function requestOnce(
  u: URL,
  rawUrl: string,
  timeoutMs: number,
  maxBytes: number,
  opts?: SafeFetchOptions,
): Promise<{
  status: number;
  contentType: string;
  bodyBytes: Uint8Array;
  redirectTo: string | null;
}> {
  return new Promise((resolve, reject) => {
    const requestFn = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req: ClientRequest = requestFn(
      u,
      {
        method: "GET",
        // The guard: every DNS resolution this socket performs is the
        // validation — see file header.
        lookup: makeGuardedLookup(rawUrl, opts),
        headers: {
          "User-Agent": "CaleoSiteImporter/1.0 (+https://caleo-cms.com/imports)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          ...opts?.headers,
        },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 301 && status <= 308 && typeof location === "string") {
          res.resume(); // drain — hop handled by the caller
          resolve({ status, contentType: "", bodyBytes: new Uint8Array(0), redirectTo: location });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        // The cap must win even when the whole body is already buffered
        // locally and "end" is queued right behind the oversized chunk.
        let capExceeded = false;
        res.on("data", (chunk: Buffer) => {
          if (capExceeded) return;
          total += chunk.length;
          if (total > maxBytes) {
            capExceeded = true;
            const err = new Error(
              `response for ${rawUrl} exceeds the ${maxBytes}-byte cap; aborted`,
            );
            req.destroy(err);
            reject(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (capExceeded) return;
          resolve({
            status,
            contentType: res.headers["content-type"] ?? "",
            bodyBytes: new Uint8Array(Buffer.concat(chunks)),
            redirectTo: null,
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`safeExternalFetch timed out fetching ${rawUrl}`));
    });
    req.on("error", reject);
    req.end();
  });
}
