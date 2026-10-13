// SPDX-License-Identifier: MPL-2.0

/**
 * Step-up for the admin's guarded actions (epic #696, maintainer decision
 * 4): installing a Caelo update and changing the update policy need a fresh
 * Google sign-in from this browser session. {@link requireStepUp} is the
 * route-side guard; the ops check again (admin-core
 * security/step-up/gate.ts) and consume the step-up, so the route cannot be
 * the only line.
 *
 * Test-only stand-in: with `CAELO_E2E_FAKE_GOOGLE_SIGNIN=1` outside
 * production, "Google" is a local fake — the sign-in redirect goes straight
 * back to the callback and the token endpoint answers with an ID token for
 * the signed-in Caelo user. Everything after the HTTP call (challenge,
 * nonce, freshness, email match, consumption) runs for real. Same gate as
 * CAELO_FAKE_IMAGE_PROVIDER: ignored when NODE_ENV=production.
 */

import {
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_ENDPOINT,
  STEP_UP_CALLBACK_PATH,
  type StepUpStatus,
  sessionHashOf,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { STEP_UP_MAX_AGE_SECONDS, type StepUpPurpose } from "@caelo-cms/shared";
import type { Cookies } from "@sveltejs/kit";
import { SESSION_COOKIE } from "./guards.js";
import { opErrorMessage } from "./op-error.js";
import { getQueryContext } from "./query.js";

/** The caller's session as guarded ops name it (sha256 of the cookie token). */
export async function sessionHashFrom(cookies: Cookies): Promise<string | null> {
  const token = cookies.get(SESSION_COOKIE);
  return token ? sessionHashOf(token) : null;
}

export type StepUpCheck =
  | { readonly fresh: true; readonly sessionHash: string; readonly freshUntil: string }
  | {
      readonly fresh: false;
      readonly sessionHash: string | null;
      /** Google sign-in set up for this install at all. */
      readonly configured: boolean;
      readonly problem: string;
    };

/**
 * Whether this session carries a Google sign-in for `purpose` from the
 * last `maxAgeSec` seconds that still authorizes one guarded action.
 */
export async function requireStepUp(
  locals: App.Locals,
  cookies: Cookies,
  purpose: StepUpPurpose,
  maxAgeSec: number = STEP_UP_MAX_AGE_SECONDS,
): Promise<StepUpCheck> {
  const sessionHash = await sessionHashFrom(cookies);
  if (!sessionHash) {
    return { fresh: false, sessionHash: null, configured: false, problem: "not signed in" };
  }
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "step_up.status", {
    sessionHash,
    purpose,
  });
  if (!r.ok) {
    return {
      fresh: false,
      sessionHash,
      configured: false,
      problem: opErrorMessage(r.error, "could not read the Google confirmation"),
    };
  }
  const s = r.value as StepUpStatus;
  if (s.freshUntil) {
    const signedInAt = new Date(s.freshUntil).getTime() - STEP_UP_MAX_AGE_SECONDS * 1000;
    if (Date.now() - signedInAt <= maxAgeSec * 1000) {
      return { fresh: true, sessionHash, freshUntil: s.freshUntil };
    }
  }
  return {
    fresh: false,
    sessionHash,
    configured: s.configured,
    problem: s.problem ?? "the Google sign-in is too old",
  };
}

/** Whether the test-only Google stand-in is on (never in production). */
export function fakeGoogleSignIn(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.CAELO_E2E_FAKE_GOOGLE_SIGNIN === "1";
}

/** The callback URL registered on the install's OAuth client. */
export function stepUpRedirectUri(origin: string): string {
  return `${origin}${STEP_UP_CALLBACK_PATH}`;
}

/**
 * Start a step-up: a challenge row, then where to send the browser —
 * Google's sign-in, or with the test stand-in straight back to the callback.
 */
export async function beginStepUp(
  locals: App.Locals,
  cookies: Cookies,
  opts: { readonly purpose: StepUpPurpose; readonly returnTo: string; readonly origin: string },
): Promise<{ ok: true; location: string } | { ok: false; error: string }> {
  const sessionHash = await sessionHashFrom(cookies);
  if (!sessionHash || !locals.user) return { ok: false, error: "Sign in again first." };
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "step_up.begin", {
    sessionHash,
    purpose: opts.purpose,
    returnTo: opts.returnTo,
    redirectUri: stepUpRedirectUri(opts.origin),
  });
  if (!r.ok) return { ok: false, error: opErrorMessage(r.error, "could not start the sign-in") };
  const url = new URL((r.value as { authorizationUrl: string }).authorizationUrl);
  if (!fakeGoogleSignIn()) return { ok: true, location: url.toString() };
  const code = `e2e.${btoa(
    JSON.stringify({ nonce: url.searchParams.get("nonce"), email: locals.user.email }),
  )}`;
  const back = new URL(stepUpRedirectUri(opts.origin));
  back.searchParams.set("state", url.searchParams.get("state") ?? "");
  back.searchParams.set("code", code);
  return { ok: true, location: back.toString() };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const jsonPart = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** The stand-in's signing key, made on first use (test runs only). */
let fakeKey: Promise<{ pair: CryptoKeyPair; jwk: JsonWebKey }> | null = null;
function fakeGoogleKey() {
  fakeKey ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return { pair, jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
  })();
  return fakeKey;
}

const FAKE_KID = "caelo-e2e-google";

/**
 * The fetch the callback reaches Google with: the real one, or the test
 * stand-in, which answers the token endpoint with an RS256 ID token for the
 * signed-in user and the JWKS URL with its public key — so the op's real
 * signature check runs against it.
 */
export function googleTokenFetch(): (url: string, init: RequestInit) => Promise<Response> {
  if (!fakeGoogleSignIn()) return (url, init) => fetch(url, init);
  return async (url, init) => {
    const { pair, jwk } = await fakeGoogleKey();
    if (url === GOOGLE_JWKS_URL) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: FAKE_KID, alg: "RS256" }] }), {
        status: 200,
      });
    }
    if (url !== GOOGLE_TOKEN_ENDPOINT) return new Response("unexpected URL", { status: 400 });
    const body = new URLSearchParams(String(init.body));
    const code = body.get("code") ?? "";
    const { nonce, email } = JSON.parse(atob(code.replace(/^e2e\./, ""))) as {
      nonce: string;
      email: string;
    };
    const now = Math.floor(Date.now() / 1000);
    const signingInput = `${jsonPart({ alg: "RS256", kid: FAKE_KID })}.${jsonPart({
      iss: "https://accounts.google.com",
      aud: body.get("client_id"),
      exp: now + 3600,
      iat: now,
      auth_time: now,
      nonce,
      email,
      email_verified: true,
    })}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return new Response(
      JSON.stringify({ id_token: `${signingInput}.${b64url(new Uint8Array(sig))}` }),
      { status: 200 },
    );
  };
}

/**
 * Flash cookie the step-up callback leaves for Settings → Updates: the
 * outcome and its message, read once. Never the URL — a crafted link could
 * otherwise put any text on the page as if it came from the sign-in.
 */
export const STEP_UP_RESULT_COOKIE = "caelo_step_up_result";
