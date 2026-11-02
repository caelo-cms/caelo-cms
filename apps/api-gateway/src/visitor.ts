// SPDX-License-Identifier: MPL-2.0

/**
 * Who a visitor request comes from — and whether the gateway may
 * recognise them at all (#677).
 *
 * The visitor id is a signed entry of the gateway's HttpOnly `__session`
 * cookie (gateway-cookies.ts, #1343) that ties one browser's requests
 * together for 30 days. Core needs it for nothing: rate limits are keyed
 * by client address (a cookie the abuser can simply drop is no limit), and
 * a captcha proof is bound to nothing but its own single use. It exists
 * only for a plugin that declares the `visitor_id` consent purpose in its
 * manifest (`consentPurposes`; today: ratings, to keep one rating per
 * visitor and page) — and that declaration names the consent category the
 * id sits under. The gateway therefore:
 *
 *   - stores it only when some ACTIVE plugin declares `visitor_id` AND the
 *     visitor's current decision grants that purpose's category (the
 *     consent provider's `visitor_consent_rule` maps purpose → category
 *     from the declarations it lists through `ctx.consentPurposes`) —
 *     never on first contact, never after "reject all", never on a site
 *     with no consent provider (nobody can have agreed) and never when no
 *     running plugin asks for it;
 *   - ignores an existing one otherwise, so nothing is keyed to it, and
 *     removes it in the same response — consent withdrawn in the banner
 *     (or the last declaring plugin switched off) reaches the HttpOnly
 *     cookie, which the page's script cannot change itself, on the next
 *     gateway call (the consent runtime's own `record_consent` call is
 *     that call).
 *
 * The decision itself arrives in the `x-caelo-consent` request header the
 * consent runtime and the component kit send (plugin-host
 * visitor-consent.ts), never in a cookie: behind Firebase Hosting only
 * `__session` reaches the gateway, on every provider alike.
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
  VISITOR_CONSENT_HEADER,
  VISITOR_ID_PURPOSE,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "@caelo-cms/plugin-host";
import { SESSION_ENTRY } from "@caelo-cms/shared";
import { GatewayCookies, VISITOR_COOKIE_MAX_AGE } from "./gateway-cookies.js";
import { verifySignedCookie } from "./middleware/signed-cookie.js";
import {
  mayCacheRead,
  publishedCacheGeneration,
  publishedCacheUsable,
} from "./published-changes.js";

export { parseCookies, VISITOR_COOKIE_MAX_AGE } from "./gateway-cookies.js";

/**
 * The invocation actor of a visitor call that carries no visitor id. The
 * dispatcher requires a non-empty actor; this one names the situation
 * instead of standing in for an id.
 */
export const ANONYMOUS_VISITOR_ACTOR = "anonymous-visitor";

// The provider's rule changes when the Owner bumps the policy version or
// the set of declared purposes changes. Cached like the gateway's settings
// (#1267, published-changes.ts): served while the gateway listens for the
// admin's publish notifications and dropped on each, so a bump takes effect
// on the next request; a change in the declarations (a plugin activated or
// switched off) drops the cache at once, so a rule built before a newly
// declared purpose existed is never applied to it.
let cachedRule: {
  rule: VisitorConsentRule | null;
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
  if (cachedRule && cachedRule.declarations === declarations && publishedCacheUsable()) {
    return cachedRule.rule;
  }
  const startedAt = publishedCacheGeneration();
  const rule = await resolveVisitorConsentRule();
  if (mayCacheRead(startedAt)) cachedRule = { rule, declarations };
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
  /** The request's `__session` container, already carrying this
   *  resolution's changes (a freshly minted id, or the removal of one the
   *  visitor may no longer hold). The response's Set-Cookie headers come
   *  from it. */
  readonly cookies: GatewayCookies;
}

/**
 * Resolve the request's visitor under the consent provider's rule.
 *
 * @param rule the provider's rule, or null when no consent provider runs.
 * @param visitorIdDeclared whether an active plugin declares the
 *   `visitor_id` purpose; without one the id is never set.
 * @param sign signs a freshly minted id for its cookie entry.
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
  const cookies = await GatewayCookies.fromRequest(args.req, args.secret);
  const sessionToken = await verifiedSessionToken(cookies, args.secret);
  const decision = args.req.headers.get(VISITOR_CONSENT_HEADER);

  if (!args.visitorIdDeclared || !visitorConsentGranted(args.rule, VISITOR_ID_PURPOSE, decision)) {
    // Remove whatever the browser still holds — set before the visitor
    // declined, under a policy version that no longer counts, or for a
    // plugin that no longer runs.
    cookies.remove(SESSION_ENTRY.visitorId);
    return { visitorId: null, sessionToken, cookies };
  }

  const held = cookies.signed(SESSION_ENTRY.visitorId);
  if (held) {
    const v = await verifySignedCookie({
      signed: held,
      secret: args.secret,
      maxAgeSeconds: VISITOR_COOKIE_MAX_AGE,
    });
    if (v && /^[0-9a-fA-F-]{36}$/.test(v.value)) {
      return { visitorId: v.value, sessionToken, cookies };
    }
  }
  // Consented, but no valid id yet (first contact, expired, tampered).
  const visitorId = crypto.randomUUID();
  cookies.setVisitorId(await args.sign(visitorId));
  return { visitorId, sessionToken, cookies };
}

/** The login entry's session token, or null; a bad entry is removed. */
async function verifiedSessionToken(
  cookies: GatewayCookies,
  secret: string,
): Promise<string | null> {
  const raw = cookies.signed(SESSION_ENTRY.login);
  if (!raw) return null;
  const s = await verifySignedCookie({
    signed: raw,
    secret,
    maxAgeSeconds: VISITOR_COOKIE_MAX_AGE,
  });
  if (s && /^[0-9a-fA-F]{64}$/.test(s.value)) return s.value;
  // Tampered, or signed with a secret that has since been rotated.
  cookies.remove(SESSION_ENTRY.login);
  return null;
}
