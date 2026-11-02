// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway's visitor cookie state for one request: what arrived in the
 * `__session` container, what this request changes, and the Set-Cookie
 * headers that store the result (#1343, `@caelo-cms/shared`
 * session-cookie.ts).
 *
 * The gateway owns two entries, both HMAC-signed with its cookie secret
 * exactly as the separate cookies were (middleware/signed-cookie.ts):
 *
 *   - `vid`   the visitor id, only with the visitor's consent (visitor.ts)
 *   - `login` the visitor's login session (the auth plugin's setSession)
 *
 * The other known entry (the staging gate's, E13 (a)) is kept as it came:
 * the gateway rewrites the container whenever its own entries change, and
 * must never drop another owner's. Keys no owner declared never survive
 * the read, so a crafted cookie cannot grow the container.
 *
 * ## Cookies from before the container
 *
 * Up to #1343 the gateway set `caelo_visitor_id` and `caelo_session`. It
 * never reads them again: a visitor logs in once more, and a consented
 * visitor gets a new id on their next call. Their consent is untouched
 * (the banner's own cookie did not move). It does expire them whenever
 * they arrive, so an id set under an old consent does not stay on a
 * device after the visitor withdrew it. `caelo_session` is expired only
 * when it carries the gateway's own signature: the admin's session cookie
 * has the same name, and on a host the two share (local development)
 * expiring it would log an editor out.
 *
 * FIXME(issue #1353): delete the legacy expiry once every release that
 * set the old cookies is more than 30 days old — both expired by then.
 */

import {
  readSessionCookie,
  SESSION_ENTRY,
  type SessionEntry,
  sessionCookieValue,
  sessionSetCookieHeader,
} from "@caelo-cms/shared";
import { verifySignedCookie } from "./middleware/signed-cookie.js";

/** The visitor id's lifetime from when it was set; also the login entry's ceiling. */
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** The cookies the gateway set before #1343; expired, never read. */
export const LEGACY_VISITOR_COOKIE = "caelo_visitor_id";
export const LEGACY_SESSION_COOKIE = "caelo_session";

function secure(): boolean {
  return process.env.NODE_ENV === "production";
}

function expireCookie(name: string): string {
  const flags = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure()) flags.push("Secure");
  return flags.join("; ");
}

/**
 * Parse a `Cookie` header. A pair whose value is not valid
 * percent-encoding is skipped: the header is visitor-controlled, and one
 * malformed cookie must not fail the request.
 */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // URIError on malformed percent-encoding: treat the cookie as absent.
    }
  }
  return out;
}

/** One request's `__session` container and the changes it makes to it. */
export class GatewayCookies {
  private readonly entries: Map<string, SessionEntry>;
  private readonly arrived: string;
  private readonly legacyExpiries: string[];
  private readonly nowSeconds: number;

  private constructor(args: {
    entries: Map<string, SessionEntry>;
    legacyExpiries: string[];
    nowSeconds: number;
  }) {
    this.entries = args.entries;
    this.arrived = sessionCookieValue(args.entries);
    this.legacyExpiries = args.legacyExpiries;
    this.nowSeconds = args.nowSeconds;
  }

  /**
   * Read the request's container, and note which legacy cookies to expire.
   *
   * @param secret the gateway's cookie secret, to tell its own legacy
   *   `caelo_session` from the admin's.
   */
  static async fromRequest(req: Request, secret: string): Promise<GatewayCookies> {
    const header = req.headers.get("cookie");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const legacy = parseCookies(header);
    const legacyExpiries: string[] = [];
    if (legacy[LEGACY_VISITOR_COOKIE] !== undefined) {
      legacyExpiries.push(expireCookie(LEGACY_VISITOR_COOKIE));
    }
    const legacySession = legacy[LEGACY_SESSION_COOKIE];
    if (legacySession && (await verifySignedCookie({ signed: legacySession, secret }))) {
      legacyExpiries.push(expireCookie(LEGACY_SESSION_COOKIE));
    }
    return new GatewayCookies({
      entries: new Map(readSessionCookie(header, nowSeconds)),
      legacyExpiries,
      nowSeconds,
    });
  }

  /** The signed value of one of the gateway's entries, unverified. */
  signed(key: typeof SESSION_ENTRY.visitorId | typeof SESSION_ENTRY.login): string | null {
    return this.entries.get(key)?.value ?? null;
  }

  /** Store a signed visitor id; it runs out {@link VISITOR_COOKIE_MAX_AGE} from now. */
  setVisitorId(signed: string): void {
    this.entries.set(SESSION_ENTRY.visitorId, {
      value: signed,
      expiresAt: this.nowSeconds + VISITOR_COOKIE_MAX_AGE,
    });
  }

  /**
   * Store a signed login session until `expiresAt` (unix seconds), at most
   * {@link VISITOR_COOKIE_MAX_AGE} from now — the age the gateway accepts
   * its signature for.
   *
   * @throws when `expiresAt` is not a number: the plugin handed
   *   `setSession` an unparseable date, and a login without an expiry
   *   must fail loudly rather than be stored.
   */
  setLogin(signed: string, expiresAt: number): void {
    if (!Number.isFinite(expiresAt)) {
      throw new Error("visitor login: setSession's expiresAt is not a valid date");
    }
    this.entries.set(SESSION_ENTRY.login, {
      value: signed,
      expiresAt: Math.min(
        Math.max(this.nowSeconds + 1, Math.floor(expiresAt)),
        this.nowSeconds + VISITOR_COOKIE_MAX_AGE,
      ),
    });
  }

  /** Remove one of the gateway's entries (withdrawn consent, logout, a bad signature). */
  remove(key: typeof SESSION_ENTRY.visitorId | typeof SESSION_ENTRY.login): void {
    this.entries.delete(key);
  }

  /**
   * The Set-Cookie headers for the response: the container when this
   * request changed it, plus the legacy expiries.
   */
  setCookieHeaders(): string[] {
    const out = [...this.legacyExpiries];
    if (sessionCookieValue(this.entries) !== this.arrived) {
      out.unshift(
        sessionSetCookieHeader(this.entries, { nowSeconds: this.nowSeconds, secure: secure() }),
      );
    }
    return out;
  }
}
