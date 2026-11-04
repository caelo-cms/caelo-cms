// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the access gate in front of `staging.<domain>`.
 *
 * One pure module shared by the two sides of the gate:
 *
 *  - the admin, which issues "Open staging" tokens and per-run tokens and
 *    shows the Owner the crawler credentials (basic auth, secret header) it
 *    derives here;
 *  - the staging gateway (#1330), which verifies every request on every host
 *    against the same rules before it serves the staged build.
 *
 * Every secret is derived from ONE shared key, the `staging-gate-secret`
 * (Secret Manager on the cloud installs, `CAELO_STAGING_GATE_SECRET` on the
 * admin). The staging gateway reads it from its own database, where the
 * admin publishes it (`published_staging_site`, #1331); no gateway holds it
 * in its env:
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

import { readSessionCookie, SESSION_ENTRY } from "./session-cookie.js";

/**
 * The staging session lives in the `staging` entry of the one `__session`
 * cookie (session-cookie.ts): the only cookie Firebase Hosting forwards over
 * the staging site's rewrite (#1325 P0, E13 a), so every provider uses it.
 */
export const STAGING_SESSION_ENTRY = SESSION_ENTRY.staging;

/**
 * #1330 — the request header the admin's own staging clients (the capture
 * job, the Stage's serve check) send their per-run token in
 * ({@link signStagingRunToken}). Never a crawler credential, never the key.
 */
export const STAGING_RUN_TOKEN_HEADER = "X-Caelo-Staging-Run";

/** What a per-run staging token may be used for. */
export type StagingRunPurpose = "capture" | "check";

/**
 * The longest a per-run token may live. The admin mints one per capture or
 * serve check; the gateway refuses one that claims a longer life, so a token
 * that leaks from a job's input is worthless soon after.
 */
export const STAGING_RUN_TOKEN_MAX_TTL_SECONDS = 15 * 60;

/** Path on the staging host that turns an "Open staging" token into the session cookie. */
export const STAGING_ACCESS_PATH = "/_caelo/staging-access";

/**
 * #1330 — path on the staging gateway that answers the admin's serve check:
 * with a per-run `check` token, the run id whose manifest a staging
 * location holds (`?location=_slots/a`). Nothing else answers there.
 */
export const STAGING_CHECK_PATH = "/_caelo/staging-check";

/** How long an "Open staging" link stays usable. Short: it travels in a URL. */
export const STAGING_OPEN_TOKEN_TTL_SECONDS = 120;

/** How long the staging session cookie keeps an operator's browser in. */
export const STAGING_SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Default name of the secret request header crawlers can send. */
export const DEFAULT_STAGING_HEADER_NAME = "X-Caelo-Staging-Key";

/**
 * The access modes of the gate. Any one satisfied lets a request in.
 * `run-token` is the admin's own (capture and serve checks, #1330): always
 * on, short-lived, minted per run.
 */
export type StagingAccessMode = "cookie" | "basic-auth" | "header" | "ip" | "run-token";

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
  | {
      readonly allowed: true;
      readonly via: StagingAccessMode;
      /**
       * Every mode the request satisfied. The proxy strips a credential
       * header only when its mode is in here: a header that merely shares
       * the gate's name (or a Basic login for the staged app itself) is the
       * site's, and reaches the origin as it would in production.
       */
      readonly satisfied: readonly StagingAccessMode[];
    }
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

/**
 * #1330 — a per-run token for one of the admin's own staging clients:
 * `run.<purpose>.<runId>.<expiresAt>.<mac>`. Scoped to its purpose and
 * stateless like the session token; `runId` names the run that asked, for
 * the logs. The admin hands it to the capture job or its serve check, which
 * send it ONLY on requests to the staging origin ({@link STAGING_RUN_TOKEN_HEADER}).
 *
 * @throws when `runId` is not a plain id or the lifetime exceeds {@link STAGING_RUN_TOKEN_MAX_TTL_SECONDS}.
 */
export async function signStagingRunToken(
  secret: string,
  purpose: StagingRunPurpose,
  runId: string,
  expiresAtSeconds: number,
  nowSeconds: number,
): Promise<string> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId))
    throw new Error(`staging run token: bad run id "${runId}"`);
  const exp = Math.floor(expiresAtSeconds);
  if (exp - nowSeconds > STAGING_RUN_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(
      `staging run token: a lifetime of ${exp - nowSeconds}s exceeds ${STAGING_RUN_TOKEN_MAX_TTL_SECONDS}s`,
    );
  }
  const mac = base64Url(await hmacBytes(secret, `caelo-staging-run:${purpose}:${runId}:${exp}`));
  return `run.${purpose}.${runId}.${exp}.${mac}`;
}

/** The purpose and run of a valid, unexpired per-run token, or null. */
export async function verifyStagingRunToken(
  secret: string,
  token: string,
  nowSeconds: number,
): Promise<{ readonly purpose: StagingRunPurpose; readonly runId: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [tag, purpose, runId, expRaw, mac] = parts as [string, string, string, string, string];
  if (tag !== "run" || (purpose !== "capture" && purpose !== "check")) return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId) || !/^\d{1,12}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  const expected = base64Url(
    await hmacBytes(secret, `caelo-staging-run:${purpose}:${runId}:${exp}`),
  );
  const valid = constantTimeEqual(mac, expected);
  if (!valid || exp <= nowSeconds || exp - nowSeconds > STAGING_RUN_TOKEN_MAX_TTL_SECONDS) {
    return null;
  }
  return { purpose, runId };
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

/** The request facts the gate looks at. */
export interface StagingAccessRequest {
  readonly cookieHeader: string | null;
  readonly authorizationHeader: string | null;
  /** Reads a request header by (case-insensitive) name. */
  readonly header: (name: string) => string | null;
  /**
   * The client address the platform vouches for, or null when unknown — and
   * null where no address can be trusted (gcp-firebase: the address behind
   * the Hosting rewrite is a Google proxy, #1325), which turns the IP
   * allowlist off.
   */
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
    const token = readSessionCookie(request.cookieHeader, args.nowSeconds).get(
      STAGING_SESSION_ENTRY,
    )?.value;
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
  // Only a capture token opens the site; a check token answers the serve
  // check (STAGING_CHECK_PATH) and nothing else.
  const runToken = request.header(STAGING_RUN_TOKEN_HEADER);
  const run = runToken ? await verifyStagingRunToken(secret, runToken, args.nowSeconds) : null;
  if (run?.purpose === "capture") granted.push("run-token");

  const via = granted[0];
  if (via) return { allowed: true, via, satisfied: granted };
  return { allowed: false, status: settings.basicAuthEnabled ? 401 : 403 };
}

/**
 * Where "Open staging" may send the browser after setting the cookie: a
 * same-origin path only (never `//host` or a scheme), else `/`.
 *
 * The result is always ASCII (safe as a `Location` header value).
 *
 * Control characters are refused outright, not only CR/LF: the WHATWG URL
 * parser deletes tabs and newlines before it parses a Location, so
 * `/<TAB>/evil.example` would otherwise become `//evil.example` in the
 * browser — an open redirect off the staging host.
 */
export function safeStagingNextPath(next: string | null): string {
  if (next === null || !next.startsWith("/") || next.startsWith("//")) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return "/";
  // Serialise through the URL parser: non-ASCII is percent-encoded (a raw
  // `/日本/` is not a valid header value and would fail the redirect), and
  // the origin check is the parser's own verdict, not ours.
  const base = "https://staging.invalid";
  const url = new URL(next, base);
  if (url.origin !== base) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * #1325 — whether the staging gate can trust a client address on
 * `provider`. Behind the gcp-firebase Hosting rewrite the address Cloud Run
 * vouches for is a Google front-end proxy that changes per request, so an
 * IP allowlist there would admit nobody or, with a forgeable entry, anybody:
 * the admin refuses to enable it and the gateway never matches it.
 */
export function stagingIpAllowlistSupported(provider: string | undefined): boolean {
  return provider !== "gcp-firebase";
}

// ─── the staging host setting ─────────────────────────────────────────

/**
 * The staging host an install gets when the operator names none:
 * `staging.<install domain>`.
 */
export function defaultStagingHost(domain: string): string {
  return `staging.${domain.trim().toLowerCase().replace(/\.$/, "")}`;
}

const FQDN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-case, trailing-dot-free form of a host the operator typed. */
export function normalizeStagingHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Why `host` cannot be the staging host, or null when it can. It must be a
 * bare fully-qualified domain name (no scheme, port or path) and must not be
 * the live site's host or an admin host — staging would otherwise shadow
 * the site or the admin it is served next to.
 *
 * @example
 *   stagingHostProblem("preview.example.com", { liveHosts: ["example.com"], adminHosts: ["admin.example.com"] })
 *   // → null
 */
export function stagingHostProblem(
  host: string,
  reserved: { readonly liveHosts: readonly string[]; readonly adminHosts: readonly string[] },
): string | null {
  const h = normalizeStagingHost(host);
  if (!FQDN.test(h)) {
    return `"${host}" is not a valid host name — use a bare domain such as staging.example.com (no https://, port or path)`;
  }
  const norm = (list: readonly string[]) => list.map(normalizeStagingHost).filter(Boolean);
  if (norm(reserved.liveHosts).includes(h)) {
    return `"${h}" is the live site's host — staging needs a host of its own (e.g. staging.${h})`;
  }
  if (norm(reserved.adminHosts).includes(h)) {
    return `"${h}" is the admin's host — pick another host for staging`;
  }
  return null;
}
