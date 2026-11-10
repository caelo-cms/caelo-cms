// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's refresh ping, checked without the database
 * (@caelo-cms/shared gateway-refresh.ts says why the admin sends it).
 *
 * A ping carries a Google-signed ID token of the admin's own runtime service
 * account, minted for this gateway's audience. Google's recipe for an ID
 * token, applied to it:
 *
 *   - the signature against the keys Google publishes for ID tokens,
 *     fetched over the network and cached, never from the database;
 *   - `iss` = Google, `aud` = this gateway's audience
 *     (`gatewayRefreshAudience`), `exp` / `iat` within a 30 s skew;
 *   - `email` = the one account this gateway takes pings from
 *     (`CAELO_GATEWAY_REFRESH_ACCOUNT`, the admin's) and `email_verified`.
 *
 * The signature check is google-auth-library's
 * `verifySignedJwtWithCertsAsync`, as for the admin's IAP assertions
 * (admin-core security/iap-assertion.ts): no hand-rolled crypto.
 *
 * Whoever may send this request is anyone on the internet, so the check
 * costs a junk request no more than it must. A token that is missing, too
 * long or not shaped like a JWT is refused before any key is looked at.
 * A token naming a key Google does not publish refetches the keys at most
 * once a minute, so junk cannot make the gateway fetch per request. A
 * refusal says why only to the log line the caller writes, never to the
 * client, and never contains the token.
 */

import { GATEWAY_REFRESH_TOKEN_HEADER } from "@caelo-cms/shared";
import { OAuth2Client } from "google-auth-library";

/** The issuers Google signs ID tokens with. */
const GOOGLE_ID_TOKEN_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

/** Max clock difference tolerated on `iat` / `exp`, in seconds. */
const CLOCK_SKEW_SECONDS = 30;

/** A Google ID token is about a kilobyte; anything this long is not one. */
const MAX_TOKEN_LENGTH = 4096;

/** Three base64url parts: the only shape a signed JWT has. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** How long fetched keys are used before a refetch. */
const KEY_CACHE_MS = 60 * 60_000;

/** How often, at most, a token naming an unknown key refetches the keys. */
export const FORCED_KEY_REFRESH_MIN_INTERVAL_MS = 60_000;

/** `kid` → PEM certificate, the shape Google publishes ID-token keys in. */
export type GoogleIdTokenKeys = Readonly<Record<string, string>>;

/**
 * Supplies Google's ID-token keys. `forceRefresh` is set when a token names
 * a `kid` the cached set lacks (Google rotated its keys).
 */
export type GoogleIdTokenKeyProvider = (opts: {
  readonly forceRefresh: boolean;
}) => Promise<GoogleIdTokenKeys>;

/** What a check of one ping says. */
export type RefreshPingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** A check bound to its account, audience and keys. */
export type RefreshPingVerifier = (token: string | null) => Promise<RefreshPingVerdict>;

/**
 * Google's ID-token keys through google-auth-library, cached for an hour.
 * A forced refresh refetches at once, but at most once per
 * {@link FORCED_KEY_REFRESH_MIN_INTERVAL_MS}. A fetch that failed is not
 * tried again within that interval either, cache or none: while Google's
 * key endpoint is down, junk on the ping path must not cause one outbound
 * fetch per request (the path is checked before any rate limit).
 *
 * @param now - milliseconds since the epoch (tests)
 */
export function googleIdTokenKeys(
  fetchKeys: () => Promise<GoogleIdTokenKeys> = async () =>
    (await new OAuth2Client().getFederatedSignonCertsAsync()).certs as GoogleIdTokenKeys,
  now: () => number = Date.now,
): GoogleIdTokenKeyProvider {
  let cached: { keys: GoogleIdTokenKeys; fetchedAt: number } | null = null;
  let lastForcedAt = Number.NEGATIVE_INFINITY;
  let lastFailure: { at: number; error: unknown } | null = null;
  let fetching: Promise<GoogleIdTokenKeys> | null = null;
  const refetch = (): Promise<GoogleIdTokenKeys> => {
    fetching ??= fetchKeys()
      .then((keys) => {
        cached = { keys, fetchedAt: now() };
        lastFailure = null;
        return keys;
      })
      .catch((error: unknown) => {
        lastFailure = { at: now(), error };
        throw error;
      })
      .finally(() => {
        fetching = null;
      });
    return fetching;
  };
  return async ({ forceRefresh }) => {
    const t = now();
    const fresh = cached !== null && t - cached.fetchedAt < KEY_CACHE_MS;
    if (cached && fresh) {
      if (!forceRefresh || t - lastForcedAt < FORCED_KEY_REFRESH_MIN_INTERVAL_MS) {
        return cached.keys;
      }
      lastForcedAt = t;
    }
    if (lastFailure && t - lastFailure.at < FORCED_KEY_REFRESH_MIN_INTERVAL_MS) {
      // The last fetch failed a moment ago: no new one yet.
      if (cached && fresh) return cached.keys;
      throw lastFailure.error;
    }
    return refetch();
  };
}

/** The `kid` of a compact JWS header, or null when it cannot be read. */
function headerKid(token: string): string | null {
  const [header] = token.split(".");
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      kid?: unknown;
    };
    return typeof parsed.kid === "string" ? parsed.kid : null;
  } catch {
    return null;
  }
}

/**
 * A check of the admin's pings to this gateway.
 *
 * @param opts.account - the only service account whose pings count (its email)
 * @param opts.audience - this gateway's `gatewayRefreshAudience`
 * @param opts.now - seconds since the epoch (tests)
 */
export function createRefreshPingVerifier(opts: {
  readonly account: string;
  readonly audience: string;
  readonly keys?: GoogleIdTokenKeyProvider;
  readonly now?: () => number;
}): RefreshPingVerifier {
  const account = opts.account.trim().toLowerCase();
  if (!account) throw new Error("a refresh ping verifier needs the account it takes pings from");
  const keys = opts.keys ?? googleIdTokenKeys();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const client = new OAuth2Client();
  const no = (reason: string): RefreshPingVerdict => ({ ok: false, reason });

  return async (token) => {
    if (!token) return no(`no ${GATEWAY_REFRESH_TOKEN_HEADER} header`);
    if (token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) return no("not a JWT");
    const kid = headerKid(token);
    if (!kid) return no("unreadable JWT header or no kid");

    let certs: GoogleIdTokenKeys;
    try {
      certs = await keys({ forceRefresh: false });
      if (!Object.hasOwn(certs, kid)) certs = await keys({ forceRefresh: true });
    } catch (e) {
      return no(
        `Google's ID-token keys unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!Object.hasOwn(certs, kid)) return no("signed with a key Google does not publish");

    let payload: Record<string, unknown> | undefined;
    try {
      const ticket = await client.verifySignedJwtWithCertsAsync(
        token,
        certs as unknown as Parameters<OAuth2Client["verifySignedJwtWithCertsAsync"]>[1],
        opts.audience,
        GOOGLE_ID_TOKEN_ISSUERS,
      );
      payload = ticket.getPayload() as Record<string, unknown> | undefined;
    } catch (e) {
      // The library's messages embed the token; keep only the reason.
      const message = e instanceof Error ? e.message : String(e);
      return no(message.split(":")[0]?.slice(0, 120) ?? "verification failed");
    }
    if (!payload) return no("no payload");

    const t = now();
    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return no("iat/exp not numeric");
    if (exp + CLOCK_SKEW_SECONDS < t) return no("expired");
    if (iat - CLOCK_SKEW_SECONDS > t) return no("issued in the future");

    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (email !== account) return no("not the admin's service account");
    // A boolean in Google's ID tokens; some issuers serialise it as a string.
    if (payload.email_verified !== true && payload.email_verified !== "true") {
      return no("email not verified");
    }
    return { ok: true };
  };
}
