// SPDX-License-Identifier: MPL-2.0

/**
 * Google OpenID Connect for the step-up re-authentication (epic #696,
 * maintainer decision 4: always a fresh Google login, never a password).
 *
 * Flow: authorization-code + PKCE against Google's fixed endpoints with
 * `max_age=0` (OIDC Core §3.1.2.1: the user must authenticate again), then
 * the code is exchanged server-side with the install's own OAuth client.
 *
 * What makes it a *fresh* login is not the request parameter but the ID
 * token: its `auth_time` must be later than the moment the step-up began.
 * Google may keep a session, but then `auth_time` is old and the step-up is
 * refused — no claim, no step-up. Also checked: issuer, audience, expiry,
 * nonce, and a verified email (matched against the Caelo user in the op).
 *
 * Signature: the ID token arrives in the token endpoint's TLS response to
 * our own authenticated request, so — per OIDC Core §3.1.3.7 step 6 — TLS
 * server validation of accounts.google.com stands in for checking the JWS
 * signature. The token never comes from the browser.
 */

/** Google's authorization endpoint (fixed; never configurable). */
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
/** Google's token endpoint (fixed; never configurable). */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Issuers Google puts in ID tokens. */
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Clock skew tolerated between Google and this server. */
const SKEW_SEC = 30;

/** Path of the callback route, relative to the admin origin. */
export const STEP_UP_CALLBACK_PATH = "/settings/updates/step-up/callback";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The per-attempt secrets of one sign-in. */
export interface ChallengeSecrets {
  /** OAuth `state`, round-tripped through Google (stored hashed). */
  readonly state: string;
  readonly nonce: string;
  /** PKCE verifier (RFC 7636), 43 characters. */
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** Fresh random state, nonce and PKCE pair. */
export async function newChallengeSecrets(): Promise<ChallengeSecrets> {
  const codeVerifier = randomToken(32);
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return {
    state: randomToken(32),
    nonce: randomToken(32),
    codeVerifier,
    codeChallenge: base64url(new Uint8Array(challenge)),
  };
}

/**
 * The Google sign-in URL for one step-up.
 *
 * @param loginHint the Caelo user's email, so Google offers that account.
 */
export function authorizationUrl(opts: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly loginHint: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    // OIDC: re-authenticate now. Verified through auth_time, see file comment.
    max_age: "0",
    // Show the account picker even with one signed-in account.
    prompt: "select_account",
    login_hint: opts.loginHint,
  });
  return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

export type OidcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** Exchange the authorization code for Google's ID token. Never throws. */
export async function exchangeCode(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  opts: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  },
): Promise<OidcResult<string>> {
  let res: Response;
  try {
    res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: opts.code,
        code_verifier: opts.codeVerifier,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: opts.redirectUri,
      }).toString(),
    });
  } catch (e) {
    return {
      ok: false,
      reason: `Google could not be reached (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const text = await res.text();
  let body: { id_token?: unknown; error?: unknown; error_description?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Reported below with the status.
  }
  if (!res.ok || typeof body.id_token !== "string") {
    const why =
      typeof body.error === "string"
        ? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}`
        : `HTTP ${res.status}`;
    return {
      ok: false,
      reason:
        why.startsWith("invalid_client") || why.startsWith("unauthorized_client")
          ? `Google rejected this install's OAuth client (${why}). Check the client ID and secret under Settings → Updates.`
          : `Google did not return an ID token (${why})`,
    };
  }
  return { ok: true, value: body.id_token };
}

/** The claims of an ID token, decoded without signature check (see file comment). */
function decodeClaims(idToken: string): Record<string, unknown> | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A verified fresh Google sign-in. */
export interface FreshSignIn {
  readonly email: string;
  /** Seconds since epoch (Google's `auth_time`). */
  readonly authTime: number;
  /** The token's nonce, which step_up.record matches against its challenge. */
  readonly nonce: string;
}

/**
 * Check the ID token proves a fresh sign-in for this step-up.
 *
 * @param startedAtSec when the step-up began (the challenge's creation)
 * @param nowSec current time, seconds since epoch
 */
export function verifyFreshSignIn(
  idToken: string,
  expect: {
    readonly clientId: string;
    readonly nonce: string;
    readonly startedAtSec: number;
    readonly nowSec: number;
  },
): OidcResult<FreshSignIn> {
  const c = decodeClaims(idToken);
  if (!c) return { ok: false, reason: "Google's ID token could not be read" };
  if (typeof c.iss !== "string" || !GOOGLE_ISSUERS.has(c.iss)) {
    return { ok: false, reason: `the ID token was not issued by Google (${String(c.iss)})` };
  }
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(expect.clientId)) {
    return { ok: false, reason: "the ID token was issued for a different OAuth client" };
  }
  if (aud.length > 1 && c.azp !== expect.clientId) {
    return { ok: false, reason: "the ID token's authorized party is a different OAuth client" };
  }
  if (typeof c.exp !== "number" || c.exp + SKEW_SEC < expect.nowSec) {
    return { ok: false, reason: "the ID token has expired" };
  }
  if (c.nonce !== expect.nonce) {
    return { ok: false, reason: "the ID token does not belong to this sign-in (nonce mismatch)" };
  }
  if (typeof c.email !== "string" || c.email_verified !== true) {
    return { ok: false, reason: "Google did not confirm a verified email address" };
  }
  if (typeof c.auth_time !== "number") {
    return {
      ok: false,
      reason:
        "Google did not say when you signed in (no auth_time claim), so a fresh sign-in cannot be proven",
    };
  }
  if (c.auth_time + SKEW_SEC < expect.startedAtSec) {
    return {
      ok: false,
      reason:
        "Google reused an earlier sign-in instead of asking for your password again. Sign out of Google in this browser (or use a private window) and try again",
    };
  }
  if (c.auth_time > expect.nowSec + SKEW_SEC) {
    return { ok: false, reason: "the sign-in time Google reported lies in the future" };
  }
  return {
    ok: true,
    value: { email: c.email.toLowerCase(), authTime: c.auth_time, nonce: expect.nonce },
  };
}
