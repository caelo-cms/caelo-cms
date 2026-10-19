// SPDX-License-Identifier: MPL-2.0

/**
 * The Google leg of the broker (issue #806): the authorization URL the
 * user is sent to, and the two token-endpoint calls (code exchange,
 * refresh). The broker forwards the MCP client's PKCE challenge to Google
 * and the client's verifier at exchange, so Google itself enforces PKCE
 * end to end and the broker never holds a verifier.
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
  // past the access token's hour without sending the user through again.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  return url.toString();
}

const GoogleTokenSchema = z.looseObject({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive(),
  token_type: z.string().regex(/^bearer$/i),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(1024).optional(),
});

const GoogleErrorSchema = z.looseObject({ error: z.string().max(128) });

/** A successful Google token response (only the fields the broker uses). */
export type GoogleTokens = z.infer<typeof GoogleTokenSchema>;

/** Outcome of a Google token call. */
export type GoogleTokenResult =
  | { readonly ok: true; readonly tokens: GoogleTokens }
  /** Google rejected the grant (bad, used or revoked code/refresh token, PKCE mismatch). */
  | { readonly ok: false; readonly kind: "invalid_grant" }
  /** Google is unreachable, answered something unexpected, or rejected the client itself. */
  | { readonly ok: false; readonly kind: "upstream"; readonly detail: string };

async function tokenCall(
  fetchImpl: typeof fetch,
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
      detail: `HTTP ${res.status}, unexpected token response shape`,
    };
  }
  return { ok: true, tokens: parsed.data };
}

/** Exchange Google's authorization code (with the MCP client's PKCE verifier). */
export function exchangeGoogleCode(
  fetchImpl: typeof fetch,
  args: {
    readonly google: GoogleClient;
    readonly publicUrl: string;
    readonly code: string;
    readonly codeVerifier: string;
  },
): Promise<GoogleTokenResult> {
  return tokenCall(fetchImpl, {
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.google.clientId,
    client_secret: args.google.clientSecret,
    redirect_uri: `${args.publicUrl}${GOOGLE_CALLBACK_PATH}`,
    code_verifier: args.codeVerifier,
  });
}

/** Refresh a Google access token. */
export function refreshGoogleToken(
  fetchImpl: typeof fetch,
  args: { readonly google: GoogleClient; readonly refreshToken: string },
): Promise<GoogleTokenResult> {
  return tokenCall(fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.google.clientId,
    client_secret: args.google.clientSecret,
  });
}
