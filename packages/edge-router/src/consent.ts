// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor-consent check every A/B runtime shares (#674).
 *
 * A/B testing stores an identifier on the visitor's device and counts
 * what they were shown. That is measurement, not something the page needs
 * in order to work, so it needs prior consent (TTDSG §25(1) / ePrivacy
 * Art. 5(3), GDPR Art. 6(1)(a)). The API gateway and every edge router
 * must answer "may this visitor be bucketed?" identically, which is why
 * the answer is one pure function here and not one per runtime.
 *
 * ## The cookie contract
 *
 * The site's consent provider (a plugin declaring `visitorConsent`; the
 * consent-manager ships one) records the visitor's decision in a
 * first-party cookie whose value is URI-encoded JSON:
 *
 *   { "granted": ["necessary", "analytics"], "policyVersion": 3 }
 *
 * Callers pass the DECODED value. The provider tells core which cookie
 * to read, which policy version is current and which of its categories
 * covers a purpose — the {@link ConsentGate}. Core never learns the
 * provider's category vocabulary beyond that one key.
 *
 * Everything that is not an unambiguous yes is a no: a missing, garbled
 * or stale-policy cookie means the visitor has not agreed to the current
 * policy, so the runtime behaves as if they had declined.
 */

/** What one runtime needs to decide a single purpose for one visitor. */
export interface ConsentGate {
  /** Name of the first-party cookie holding the decision. */
  readonly cookie: string;
  /** The policy version a decision must carry to count. */
  readonly policyVersion: number;
  /** The provider's category that covers the purpose (e.g. "analytics"). */
  readonly category: string;
}

/**
 * Whether the visitor's recorded decision grants the gate's category
 * under the current policy.
 *
 * @param gate the provider's rule for this purpose.
 * @param cookieValue the decoded value of `gate.cookie`, or null when
 *   the request carries no such cookie.
 */
export function consentGranted(gate: ConsentGate, cookieValue: string | null): boolean {
  if (!cookieValue) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cookieValue);
  } catch {
    // A decision we cannot read is a decision we do not have.
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const { granted, policyVersion } = parsed as { granted?: unknown; policyVersion?: unknown };
  if (policyVersion !== gate.policyVersion) return false;
  if (!Array.isArray(granted)) return false;
  return granted.includes(gate.category);
}

/** Read one cookie's decoded value from a `Cookie` request header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      // Malformed percent-encoding: treat as absent rather than throw on
      // a visitor-controlled header.
      return null;
    }
  }
  return null;
}
