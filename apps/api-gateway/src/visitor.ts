// SPDX-License-Identifier: MPL-2.0

/**
 * Who a visitor request comes from — and whether the gateway may
 * recognise them at all (#677).
 *
 * `caelo_visitor_id` is a signed, HttpOnly, 30-day cookie that ties one
 * browser's requests together. Core needs it for nothing: rate limits are
 * keyed by client address (a cookie the abuser can simply drop is no
 * limit), and a captcha proof is bound to nothing but its own single use.
 * It exists only for a plugin that declares the `visitor_id` consent
 * purpose in its manifest (`consentPurposes`; today: ratings, to keep one
 * rating per visitor and page) — and that declaration names the consent
 * category the cookie sits under. The gateway therefore:
 *
 *   - sets it only when some ACTIVE plugin declares `visitor_id` AND the
 *     visitor's current decision grants that purpose's category (the
 *     consent provider's `visitor_consent_rule` maps purpose → category
 *     from the declarations it lists through `ctx.consentPurposes`) —
 *     never on first contact, never after "reject all", never on a site
 *     with no consent provider (nobody can have agreed) and never when no
 *     running plugin asks for it;
 *   - ignores an existing one otherwise, so nothing is keyed to it, and
 *     expires it in the same response — consent withdrawn in the banner
 *     (or the last declaring plugin switched off) reaches the HttpOnly
 *     cookie, which the page's script cannot delete itself, on the next
 *     gateway call (the consent runtime's own `record_consent` beacon is
 *     that call).
 *
 * Both answers come from this process: the declarations are read off the
 * plugins the gateway's dispatch-only host attached from what the admin
 * published as active, and the rule from the consent provider running in
 * that same host. Nothing is read from cms_admin (CLAUDE.md §2, #635).
 *
 * Without an id, plugins see `ctx.visitor.id === null`.
 */

import {
  consentPurposeDeclared,
  declaredConsentPurposes,
  resolveVisitorConsentRule,
  VISITOR_ID_PURPOSE,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "@caelo-cms/plugin-host";
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

// The provider's rule changes when the Owner bumps the policy version or
// the set of declared purposes changes. The same 5 s ceiling as the
// gateway's settings keeps a bump from taking effect late while sparing
// every request a provider round-trip; a change in the declarations (a
// plugin activated or switched off) drops the cache at once, so a rule
// built before a newly declared purpose existed is never applied to it.
const CONSENT_RULE_TTL_MS = 5_000;
let cachedRule: {
  rule: VisitorConsentRule | null;
  loadedAt: number;
  declarations: string;
} | null = null;

/** What the cached rule was built from: every declared purpose and its category. */
function declarationsSignature(): string {
  return JSON.stringify(declaredConsentPurposes().map((p) => [p.pluginSlug, p.key, p.category]));
}

/**
 * The consent provider's current rule, cached briefly.
 *
 * @returns null when no consent provider runs on this site.
 * @throws when the provider runs but cannot answer — the caller answers
 *   503 rather than guess the visitor's decision.
 */
export async function loadVisitorConsentRule(): Promise<VisitorConsentRule | null> {
  const declarations = declarationsSignature();
  if (
    cachedRule &&
    cachedRule.declarations === declarations &&
    Date.now() - cachedRule.loadedAt < CONSENT_RULE_TTL_MS
  ) {
    return cachedRule.rule;
  }
  const rule = await resolveVisitorConsentRule();
  cachedRule = { rule, loadedAt: Date.now(), declarations };
  return rule;
}

/** Drop the cached rule (settings invalidation, tests). */
export function invalidateVisitorConsentRule(): void {
  cachedRule = null;
}

/** Whether an active plugin on this host declares the `visitor_id` purpose. */
export function visitorIdDeclared(): boolean {
  return consentPurposeDeclared(VISITOR_ID_PURPOSE);
}

export interface ResolvedVisitor {
  /** The visitor id, or null when the visitor has not consented to one
   *  (or no running plugin declares the purpose it serves). */
  readonly visitorId: string | null;
  readonly sessionToken: string | null;
  /** Visitor-cookie Set-Cookie headers this response must carry: a freshly
   *  minted id, or the expiry of one the visitor may no longer hold. */
  readonly setCookies: readonly string[];
}

/**
 * Resolve the request's visitor under the consent provider's rule.
 *
 * @param rule the provider's rule, or null when no consent provider runs.
 * @param visitorIdDeclared whether an active plugin declares the
 *   `visitor_id` purpose; without one the id is never set.
 * @param sign signs a freshly minted id for its cookie.
 * @throws when a plugin declares the visitor-id purpose but the provider's
 *   rule does not classify it — a wiring error, not a silent no.
 */
export async function resolveVisitor(args: {
  readonly req: Request;
  readonly secret: string;
  readonly rule: VisitorConsentRule | null;
  readonly visitorIdDeclared: boolean;
  readonly sign: (value: string) => Promise<string>;
}): Promise<ResolvedVisitor> {
  const cookies = parseCookies(args.req.headers.get("cookie"));
  const rawVisitor = cookies[VISITOR_COOKIE] ?? "";
  const sessionToken = await verifiedSessionToken(cookies[SESSION_COOKIE] ?? "", args.secret);

  if (!args.visitorIdDeclared || !visitorConsentGranted(args.rule, VISITOR_ID_PURPOSE, cookies)) {
    return {
      visitorId: null,
      sessionToken,
      // Expire whatever the browser still holds — set before the visitor
      // declined, under a policy version that no longer counts, or for a
      // plugin that no longer runs.
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
      return { visitorId: v.value, sessionToken, setCookies: [] };
    }
  }
  // Consented, but no valid id yet (first contact, expired, tampered).
  const visitorId = crypto.randomUUID();
  return {
    visitorId,
    sessionToken,
    setCookies: [visitorCookieHeader(await args.sign(visitorId))],
  };
}

async function verifiedSessionToken(raw: string, secret: string): Promise<string | null> {
  if (!raw) return null;
  const s = await verifySignedCookie({
    signed: raw,
    secret,
    maxAgeSeconds: VISITOR_COOKIE_MAX_AGE,
  });
  return s && /^[0-9a-fA-F]{64}$/.test(s.value) ? s.value : null;
}
