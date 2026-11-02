// SPDX-License-Identifier: MPL-2.0

/**
 * The Google leg of the broker (issue #806): the authorization URL the
 * user is sent to, and the two token-endpoint calls (code exchange,
 * refresh). The broker forwards the MCP client's PKCE challenge to Google
 * and the client's verifier at exchange, so Google enforces PKCE too —
 * after the broker has already checked the verifier against the challenge
 * it sealed (token.ts), so a wrong verifier never costs a Google call.
 *
 * What the MCP client gets as its bearer is Google's **ID token**, not the
 * access token: IAP's documented programmatic access takes "an OAuth 2.0
 * ID token with the audience claim set to" the allowlisted client, sent as
 * `Authorization: Bearer`, and refreshes with the refresh token yield "a
 * new `id_token`"
 * (https://docs.cloud.google.com/iap/docs/authentication-howto, "Authenticate
 * from a desktop app" → "Access the application" / "Refresh token",
 * checked 2026-10-19). The issue #806 spike saw IAP also accept the access
 * token, but that is undocumented; the broker relies on the documented
 * contract. Google returns an ID token on refresh because `openid` is
 * among the granted scopes.
 *
 * Nothing here logs a token, code or secret: failures are reported by
 * HTTP status and Google's `error` code only.
 */

import { z } from "zod";
import type { GoogleClient } from "./config.js";

/** Google's OAuth 2.0 endpoints (https://accounts.google.com/.well-known/openid-configuration). */
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** How long a Google token call may take before the broker answers 503. */
const GOOGLE_TIMEOUT_MS = 10_000;

/** The path of the one redirect URI registered on the Google OAuth client. */
export const GOOGLE_CALLBACK_PATH = "/api/mcp/oauth/google-callback";

/** The scopes requested from Google: identity only — IAP needs the email. */
export const GOOGLE_SCOPES = "openid email";

/** Build the Google authorization URL for one sign-in. */
export function googleAuthorizeUrl(args: {
  readonly google: GoogleClient;
  readonly publicUrl: string;
  readonly codeChallenge: string;
  readonly state: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", args.google.clientId);
  url.searchParams.set("redirect_uri", `${args.publicUrl}${GOOGLE_CALLBACK_PATH}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  // A refresh token on every sign-in: the MCP client must stay connected
  // past the ID token's hour without sending the user through again.
  // Google only returns a refresh token on a consent screen, and the broker
  // is stateless — it cannot know whether this user already holds one for
  // this connection — so it asks for consent every time. Cost: Google
  // keeps at most 100 refresh tokens per user per OAuth client and revokes
  // the oldest beyond that, so a user's 101st sign-in silently ends the
  // oldest connection (which then signs in again). Each connection is
  // capped at 30 days anyway (token.ts REFRESH_MAX_LIFETIME_SECONDS).
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  return url.toString();
}

/** Google's access token is ignored (never handed out): only the ID token is the client's bearer. */
const GoogleTokenSchema = z.looseObject({
  id_token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  expires_in: z.number().int().positive(),
  token_type: z.string().regex(/^bearer$/i),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(1024).optional(),
});

const IdTokenClaimsSchema = z.looseObject({
  aud: z.string(),
  exp: z.number().int(),
});

const GoogleErrorSchema = z.looseObject({ error: z.string().max(128) });

/** A successful Google token response, with the ID token's lifetime read from its claims. */
export interface GoogleTokens {
  /** The ID token: what the MCP client sends as its bearer (IAP takes it). */
  readonly idToken: string;
  /** Seconds until the ID token's `exp`. */
  readonly idTokenExpiresIn: number;
  readonly refreshToken?: string;
  readonly scope?: string;
}

/** Outcome of a Google token call. */
export type GoogleTokenResult =
  | { readonly ok: true; readonly tokens: GoogleTokens }
  /** Google rejected the grant (bad, used or revoked code/refresh token, PKCE mismatch). */
  | { readonly ok: false; readonly kind: "invalid_grant" }
  /** Google is unreachable, answered something unexpected, or rejected the client itself. */
  | { readonly ok: false; readonly kind: "upstream"; readonly detail: string };

/**
 * The ID token's audience and expiry. Not a signature check: the token
 * came straight from Google's token endpoint over TLS, which OpenID
 * Connect Core §3.1.3.7 (6) accepts in place of one — and IAP verifies the
 * signature on every request anyway. The audience check catches a client
 * file that does not match the client Google actually issued for.
 */
function idTokenClaims(idToken: string): z.infer<typeof IdTokenClaimsSchema> | null {
  const payload = idToken.split(".")[1] ?? "";
  try {
    const parsed = IdTokenClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function tokenCall(
  fetchImpl: typeof fetch,
  google: GoogleClient,
  nowSeconds: number,
  params: Record<string, string>,
): Promise<GoogleTokenResult> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, kind: "upstream", detail: e instanceof Error ? e.name : "fetch failed" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "upstream", detail: `HTTP ${res.status}, body not JSON` };
  }
  if (!res.ok) {
    const err = GoogleErrorSchema.safeParse(body);
    const code = err.success ? err.data.error : "unknown";
    // invalid_grant is the user's grant (expired, used, revoked, wrong
    // verifier); everything else (invalid_client, unauthorized_client…)
    // is this install's Google client and needs the Owner, not a re-login.
    if (code === "invalid_grant") return { ok: false, kind: "invalid_grant" };
    return { ok: false, kind: "upstream", detail: `HTTP ${res.status}, error=${code}` };
  }
  const parsed = GoogleTokenSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "upstream",
      detail: `HTTP ${res.status}, unexpected token response shape (an ID token is required; is "openid" granted?)`,
    };
  }
  const claims = idTokenClaims(parsed.data.id_token);
  if (!claims) {
    return { ok: false, kind: "upstream", detail: "the ID token's claims are unreadable" };
  }
  if (claims.aud !== google.clientId) {
    return {
      ok: false,
      kind: "upstream",
      detail: "the ID token's audience is not the configured Google client",
    };
  }
  const expiresIn = claims.exp - nowSeconds;
  if (expiresIn <= 0) {
    return { ok: false, kind: "upstream", detail: "Google returned an already expired ID token" };
  }
  return {
    ok: true,
    tokens: {
      idToken: parsed.data.id_token,
      idTokenExpiresIn: expiresIn,
      ...(parsed.data.refresh_token !== undefined
        ? { refreshToken: parsed.data.refresh_token }
        : {}),
      ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
    },
  };
}

/** Exchange Google's authorization code (with the MCP client's PKCE verifier). */
export function exchangeGoogleCode(
  fetchImpl: typeof fetch,
  args: {
    readonly google: GoogleClient;
    readonly publicUrl: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly nowSeconds: number;
  },
): Promise<GoogleTokenResult> {
  return tokenCall(fetchImpl, args.google, args.nowSeconds, {
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.google.clientId,
    client_secret: args.google.clientSecret,
    redirect_uri: `${args.publicUrl}${GOOGLE_CALLBACK_PATH}`,
    code_verifier: args.codeVerifier,
  });
}

/** Refresh: a new ID token (and, rarely, a rotated refresh token). */
export function refreshGoogleToken(
  fetchImpl: typeof fetch,
  args: {
    readonly google: GoogleClient;
    readonly refreshToken: string;
    readonly nowSeconds: number;
  },
): Promise<GoogleTokenResult> {
  return tokenCall(fetchImpl, args.google, args.nowSeconds, {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.google.clientId,
    client_secret: args.google.clientSecret,
  });
}
