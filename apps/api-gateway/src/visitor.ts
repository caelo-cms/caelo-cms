// SPDX-License-Identifier: MPL-2.0

/**
 * Who a visitor request comes from — and, since #677, whether the gateway
 * may recognise them at all.
 *
 * `caelo_visitor_id` is a signed, HttpOnly, 30-day cookie that ties one
 * browser's requests together. It is not strictly necessary for anything
 * a visitor asks the gateway to do, so it is an `analytics` cookie (the
 * consent provider's `visitor_consent_rule` says which category covers it;
 * the reasoning lives there). The gateway therefore:
 *
 *   - sets it only when the visitor's current decision grants that
 *     category — never on first contact, never after "reject all", and
 *     never on a site with no consent provider (nobody can have agreed);
 *   - ignores an existing one without that consent, so nothing is keyed
 *     to it server-side, and expires it in the same response — consent
 *     withdrawn in the banner reaches the HttpOnly cookie, which the
 *     page's script cannot delete itself, on the next gateway call (the
 *     consent runtime's own `record_consent` beacon is that call).
 *
 * What depends on the id degrades explicitly when it is absent: the rate
 * limiter keys by client IP (as it always did for unrecognised visitors),
 * plugins see `ctx.visitor.id === null`, and the request log and PoW
 * challenge store an empty visitor hash.
 */

import {
  resolveVisitorConsentRule,
  VISITOR_ID_PURPOSE,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "@caelo-cms/plugin-host";
import { hashVisitorId } from "./middleware/captcha.js";
import { verifySignedCookie } from "./middleware/signed-cookie.js";

export const VISITOR_COOKIE = "caelo_visitor_id";
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
export const SESSION_COOKIE = "caelo_session";

/**
 * The invocation actor of a visitor call that carries no visitor id. The
 * dispatcher requires a non-empty actor; this one names the situation
 * instead of standing in for an id.
 */
export const ANONYMOUS_VISITOR_ACTOR = "anonymous-visitor";

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

function secureFlag(flags: string[]): string {
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}

/** Set-Cookie for a freshly minted, signed visitor id. */
export function visitorCookieHeader(value: string): string {
  return secureFlag([
    `${VISITOR_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE}`,
  ]);
}

/** Set-Cookie that expires the visitor id (consent withdrawn or never given). */
export function clearVisitorCookieHeader(): string {
  return secureFlag([`${VISITOR_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]);
}

// The provider's rule changes only when the Owner bumps the policy version;
// the same 5 s ceiling as the gateway's settings keeps a bump from taking
// effect late while sparing every request a provider round-trip.
const CONSENT_RULE_TTL_MS = 5_000;
let cachedRule: { rule: VisitorConsentRule | null; loadedAt: number } | null = null;

/**
 * The consent provider's current rule, cached briefly.
 *
 * @returns null when no consent provider runs on this site.
 * @throws when the provider runs but cannot answer — the caller answers
 *   503 rather than guess the visitor's decision.
 */
export async function loadVisitorConsentRule(): Promise<VisitorConsentRule | null> {
  if (cachedRule && Date.now() - cachedRule.loadedAt < CONSENT_RULE_TTL_MS) return cachedRule.rule;
  const rule = await resolveVisitorConsentRule();
  cachedRule = { rule, loadedAt: Date.now() };
  return rule;
}

/** Drop the cached rule (settings invalidation, tests). */
export function invalidateVisitorConsentRule(): void {
  cachedRule = null;
}

export interface ResolvedVisitor {
  /** The visitor id, or null when the visitor has not consented to one. */
  readonly visitorId: string | null;
  /** Non-reversible hash for the request log / PoW row; "" without an id. */
  readonly visitorIdHash: string;
  /** True only when the id came from a verified cookie the visitor already
   *  held — the rate limiter's per-visitor key needs one it did not just
   *  hand out, or rotating cookies would reset the budget. */
  readonly recognised: boolean;
  readonly sessionToken: string | null;
  /** Visitor-cookie Set-Cookie headers this response must carry: a freshly
   *  minted id, or the expiry of one the visitor no longer consents to. */
  readonly setCookies: readonly string[];
}

/**
 * Resolve the request's visitor under the consent provider's rule.
 *
 * @param rule the provider's rule, or null when no consent provider runs.
 * @param sign signs a freshly minted id for its cookie.
 * @throws when the rule does not classify the visitor-id purpose.
 */
export async function resolveVisitor(args: {
  readonly req: Request;
  readonly secret: string;
  readonly rule: VisitorConsentRule | null;
  readonly sign: (value: string) => Promise<string>;
}): Promise<ResolvedVisitor> {
  const cookies = parseCookies(args.req.headers.get("cookie"));
  const rawVisitor = cookies[VISITOR_COOKIE] ?? "";
  const sessionToken = await verifiedSessionToken(cookies[SESSION_COOKIE] ?? "", args.secret);

  if (!visitorConsentGranted(args.rule, VISITOR_ID_PURPOSE, cookies)) {
    return {
      visitorId: null,
      visitorIdHash: "",
      recognised: false,
      sessionToken,
      // Expire whatever the browser still holds — set before the visitor
      // declined, or under a policy version that no longer counts.
      setCookies: rawVisitor ? [clearVisitorCookieHeader()] : [],
    };
  }

  if (rawVisitor) {
    const v = await verifySignedCookie({
      signed: rawVisitor,
      secret: args.secret,
      maxAgeSeconds: VISITOR_COOKIE_MAX_AGE,
    });
    if (v && /^[0-9a-fA-F-]{36}$/.test(v.value)) {
      return {
        visitorId: v.value,
        visitorIdHash: hashVisitorId(v.value),
        recognised: true,
        sessionToken,
        setCookies: [],
      };
    }
  }
  // Consented, but no valid id yet (first contact, expired, tampered).
  const visitorId = crypto.randomUUID();
  return {
    visitorId,
    visitorIdHash: hashVisitorId(visitorId),
    recognised: false,
    sessionToken,
    setCookies: [visitorCookieHeader(await args.sign(visitorId))],
  };
}

async function verifiedSessionToken(raw: string, secret: string): Promise<string | null> {
  if (!raw) return null;
  const s = await verifySignedCookie({ signed: raw, secret });
  return s && /^[0-9a-fA-F]{64}$/.test(s.value) ? s.value : null;
}
