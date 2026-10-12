// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the access gate in front of `staging.<domain>`.
 *
 * One pure module shared by the two sides of the gate:
 *
 *  - the admin, which issues "Open staging" tokens and shows the Owner the
 *    crawler credentials (basic auth, secret header) it derives here;
 *  - the gateway (gcp-firebase), which verifies every staging request
 *    against the same rules before it proxies to the staged build.
 *
 * Every secret is derived from ONE shared key, the `staging-gate-secret`
 * in Secret Manager (`CAELO_STAGING_GATE_SECRET` on admin + gateway):
 *
 *  - Crawler credentials are `HMAC(key, kind + nonce)`. The database keeps
 *    only the random nonce, so a database read alone reveals no credential,
 *    and rotating a credential is writing a new nonce — no redeploy, no
 *    Secret Manager write from the admin at runtime.
 *  - "Open staging" tokens and the session cookie they turn into are
 *    `purpose.expiry.HMAC(key, purpose + expiry)`: stateless, short-lived,
 *    and useless for any other purpose.
 *
 * Every comparison of a presented secret is constant-time. WebCrypto only,
 * so the module runs unchanged in Bun, Node and the admin's SvelteKit build.
 */

/** Cookie the gateway sets on `staging.<domain>` after "Open staging". */
export const STAGING_SESSION_COOKIE = "caelo_staging_access";

/** Path on the staging host that turns an "Open staging" token into the session cookie. */
export const STAGING_ACCESS_PATH = "/_caelo/staging-access";

/** How long an "Open staging" link stays usable. Short: it travels in a URL. */
export const STAGING_OPEN_TOKEN_TTL_SECONDS = 120;

/** How long the staging session cookie keeps an operator's browser in. */
export const STAGING_SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Default name of the secret request header crawlers can send. */
export const DEFAULT_STAGING_HEADER_NAME = "X-Caelo-Staging-Key";

/** The access modes of the gate. Any one satisfied lets a request in. */
export type StagingAccessMode = "cookie" | "basic-auth" | "header" | "ip";

/** The gate's settings as stored (`staging_access`, migration 0251). */
export interface StagingAccessSettings {
  readonly cookieEnabled: boolean;
  readonly basicAuthEnabled: boolean;
  readonly basicAuthUser: string;
  /** Random per-rotation nonce; null until the credential was first generated. */
  readonly basicAuthNonce: string | null;
  readonly headerEnabled: boolean;
  readonly headerName: string;
  readonly headerNonce: string | null;
  /** CIDRs (`203.0.113.7/32`, `2001:db8::/48`); a bare address means /32 or /128. */
  readonly ipAllowlist: readonly string[];
}

/** What the gate decided for one request. */
export type StagingAccessDecision =
  | { readonly allowed: true; readonly via: StagingAccessMode }
  | {
      readonly allowed: false;
      /** 401 + `WWW-Authenticate: Basic` when basic auth is on, else 403. */
      readonly status: 401 | 403;
    };

const ENCODER = new TextEncoder();

async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ENCODER.encode(message)));
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time string comparison. Inputs of different length compare
 * unequal without an early exit on the first differing byte; the length
 * itself is not secret (every derived credential has a fixed length).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = ENCODER.encode(a);
  const y = ENCODER.encode(b);
  const other = x.length === y.length ? y : x;
  let diff = x.length === y.length ? 0 : 1;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (other[i] ?? 0);
  return diff === 0;
}

/** A fresh random nonce for a credential rotation (24 random bytes, base64url). */
export function newStagingCredentialNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/**
 * The crawler credential (basic-auth password or secret header value) for
 * `nonce`. 32 URL-safe characters (192 bits).
 *
 * @example
 *   await deriveStagingCredential(gateSecret, "basic-auth", settings.basicAuthNonce)
 */
export async function deriveStagingCredential(
  secret: string,
  kind: "basic-auth" | "header",
  nonce: string,
): Promise<string> {
  const mac = await hmacBytes(secret, `caelo-staging-credential:${kind}:${nonce}`);
  return base64Url(mac.slice(0, 24));
}

type TokenPurpose = "open" | "session";

/**
 * A signed, expiring token: `<purpose>.<expiresAtSeconds>.<mac>`. `open` is
 * the one-time-ish link the admin hands the browser; `session` is the cookie
 * the gateway sets in exchange.
 */
export async function signStagingToken(
  secret: string,
  purpose: TokenPurpose,
  expiresAtSeconds: number,
): Promise<string> {
  const exp = Math.floor(expiresAtSeconds);
  const mac = base64Url(await hmacBytes(secret, `caelo-staging:${purpose}:${exp}`));
  return `${purpose}.${exp}.${mac}`;
}

/** True when `token` is a valid, unexpired token for `purpose`. */
export async function verifyStagingToken(
  secret: string,
  token: string,
  purpose: TokenPurpose,
  nowSeconds: number,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [p, expRaw, mac] = parts as [string, string, string];
  if (p !== purpose || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  const expected = base64Url(await hmacBytes(secret, `caelo-staging:${purpose}:${exp}`));
  // Compare before checking expiry so the timing does not tell an expired
  // token from a forged one.
  const valid = constantTimeEqual(mac, expected);
  return valid && exp > nowSeconds;
}

// ─── IP allowlist ─────────────────────────────────────────────────────

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIpv6(s: string): number[] | null {
  let text = s;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Parse an IP address into bytes; an IPv4-mapped IPv6 address becomes IPv4. */
function parseIp(raw: string): number[] | null {
  const s = raw.trim().replace(/^\[|\]$/g, "");
  if (s.includes(":")) {
    const v6 = parseIpv6(s.split("%")[0] ?? "");
    if (!v6) return null;
    const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    return mapped ? v6.slice(12) : v6;
  }
  return parseIpv4(s);
}

/** A parsed CIDR, or null when `cidr` is not one. A bare address is a host route. */
export function parseCidr(
  cidr: string,
): { readonly bytes: number[]; readonly bits: number } | null {
  const [addr, len, extra] = cidr.trim().split("/");
  if (addr === undefined || extra !== undefined) return null;
  const bytes = parseIp(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  if (len === undefined) return { bytes, bits: max };
  if (!/^\d{1,3}$/.test(len)) return null;
  const bits = Number(len);
  return bits <= max ? { bytes, bits } : null;
}

/** True when `ip` lies inside `cidr` (same address family only). */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const addr = parseIp(ip);
  const net = parseCidr(cidr);
  if (!addr || !net || addr.length !== net.bytes.length) return false;
  let bits = net.bits;
  for (let i = 0; i < addr.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((addr[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

// ─── request decision ─────────────────────────────────────────────────

/** `Authorization: Basic …` → user + password, or null. */
export function parseBasicAuthorization(
  header: string | null,
): { user: string; password: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/** The value of cookie `name` in a `Cookie` header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The request facts the gate looks at. */
export interface StagingAccessRequest {
  readonly cookieHeader: string | null;
  readonly authorizationHeader: string | null;
  /** Reads a request header by (case-insensitive) name. */
  readonly header: (name: string) => string | null;
  /** The client address the platform vouches for, or null when unknown. */
  readonly clientIp: string | null;
}

/**
 * Decide one staging request. Any enabled mode that the request satisfies
 * lets it in; every check runs (no short-circuit on the first secret
 * comparison), so the response time does not reveal which mode failed.
 */
export async function decideStagingAccess(args: {
  readonly settings: StagingAccessSettings;
  readonly secret: string;
  readonly request: StagingAccessRequest;
  readonly nowSeconds: number;
}): Promise<StagingAccessDecision> {
  const { settings, secret, request } = args;
  const granted: StagingAccessMode[] = [];

  if (settings.cookieEnabled) {
    const token = readCookie(request.cookieHeader, STAGING_SESSION_COOKIE);
    if (token && (await verifyStagingToken(secret, token, "session", args.nowSeconds))) {
      granted.push("cookie");
    }
  }
  if (settings.basicAuthEnabled && settings.basicAuthNonce) {
    const presented = parseBasicAuthorization(request.authorizationHeader);
    const expected = await deriveStagingCredential(secret, "basic-auth", settings.basicAuthNonce);
    const userOk = constantTimeEqual(presented?.user ?? "", settings.basicAuthUser);
    const passOk = constantTimeEqual(presented?.password ?? "", expected);
    if (presented && userOk && passOk) granted.push("basic-auth");
  }
  if (settings.headerEnabled && settings.headerNonce) {
    const presented = request.header(settings.headerName) ?? "";
    const expected = await deriveStagingCredential(secret, "header", settings.headerNonce);
    if (constantTimeEqual(presented, expected) && presented !== "") granted.push("header");
  }
  const ip = request.clientIp;
  if (ip && settings.ipAllowlist.some((c) => ipMatchesCidr(ip, c))) granted.push("ip");

  const via = granted[0];
  if (via) return { allowed: true, via };
  return { allowed: false, status: settings.basicAuthEnabled ? 401 : 403 };
}

/**
 * Where "Open staging" may send the browser after setting the cookie: a
 * same-origin path only (never `//host` or a scheme), else `/`.
 */
export function safeStagingNextPath(next: string | null): string {
  if (next === null || !next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.includes("\\") || /[\r\n]/.test(next)) return "/";
  return next;
}
