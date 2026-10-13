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
 * Whether this session carries a Google sign-in from the last `maxAgeSec`
 * seconds that still authorizes one guarded action.
 */
export async function requireStepUp(
  locals: App.Locals,
  cookies: Cookies,
  maxAgeSec: number = STEP_UP_MAX_AGE_SECONDS,
): Promise<StepUpCheck> {
  const sessionHash = await sessionHashFrom(cookies);
  if (!sessionHash) {
    return { fresh: false, sessionHash: null, configured: false, problem: "not signed in" };
  }
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "step_up.status", { sessionHash });
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

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The fetch the callback exchanges the code with: Google, or the test stand-in. */
export function googleTokenFetch(): (url: string, init: RequestInit) => Promise<Response> {
  if (!fakeGoogleSignIn()) return (url, init) => fetch(url, init);
  return async (url, init) => {
    if (url !== GOOGLE_TOKEN_ENDPOINT) return new Response("unexpected URL", { status: 400 });
    const body = new URLSearchParams(String(init.body));
    const code = body.get("code") ?? "";
    const { nonce, email } = JSON.parse(atob(code.replace(/^e2e\./, ""))) as {
      nonce: string;
      email: string;
    };
    const now = Math.floor(Date.now() / 1000);
    const idToken = `${b64url({ alg: "none" })}.${b64url({
      iss: "https://accounts.google.com",
      aud: body.get("client_id"),
      exp: now + 3600,
      iat: now,
      auth_time: now,
      nonce,
      email,
      email_verified: true,
    })}.e2e`;
    return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
  };
}

/**
 * Flash cookie the step-up callback leaves for Settings → Updates: the
 * outcome and its message, read once. Never the URL — a crafted link could
 * otherwise put any text on the page as if it came from the sign-in.
 */
export const STEP_UP_RESULT_COOKIE = "caelo_step_up_result";
