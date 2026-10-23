// SPDX-License-Identifier: MPL-2.0

/**
 * #967 — Google's OAuth endpoints as they answered live on 2026-10-21
 * (`recorded-google-oauth.json`: read-only probes, redirects not followed,
 * no real secret involved), and a `fetch` that replays them. The unit and
 * integration tests use it, and so does the Playwright stand-in
 * (CAELO_E2E_GOOGLE_IAP), so every test classifies the same bytes Google
 * really sends instead of a hand-written imitation.
 *
 * The one answer not recorded is the valid-pair `invalid_grant` (it needs a
 * real client secret); its shape is Google's documented token error
 * (`{"error":"invalid_grant","error_description":"Malformed auth code."}`)
 * and is verified on the first live install run.
 */

import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "./preflight.js";
import recorded from "./recorded-google-oauth.json" with { type: "json" };

/** One recorded exchange. */
export interface RecordedGoogleResponse {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

/** The recorded case by name (`authorize_registered_iap_uri`, `token_wrong_secret`, …). */
export function recordedGoogleResponse(name: string): RecordedGoogleResponse {
  const c = (recorded.cases as Record<string, { response: RecordedGoogleResponse }>)[name];
  if (!c) throw new Error(`recorded-google-oauth.json has no case "${name}"`);
  return c.response;
}

/** What the replaying Google knows about a client. */
export interface RecordedGoogleClients {
  /** Whether `clientId` exists at all. */
  readonly exists: (clientId: string) => boolean;
  /** Whether `redirectUri` is registered on the (existing) client. */
  readonly registered: (clientId: string, redirectUri: string) => boolean;
  /** Whether `secret` is the (existing) client's. */
  readonly secretValid: (clientId: string, secret: string) => boolean;
}

const VALID_PAIR = JSON.stringify({
  error: "invalid_grant",
  error_description: "Malformed auth code.",
});

function respond(r: RecordedGoogleResponse): Response {
  return new Response(r.body || null, {
    status: r.status,
    headers: r.location ? { location: r.location } : {},
  });
}

/**
 * A `fetch` for the preflight and the self-check's redirect-URI lines that
 * answers like Google did, per `clients`. Any other URL is passed to
 * `fallback` (e.g. a fake IAP in front of the admin); without one it throws.
 */
export function recordedGoogleOAuthFetch(
  clients: RecordedGoogleClients,
  fallback?: typeof fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const endpoint = `${url.origin}${url.pathname}`;
    if (endpoint === GOOGLE_AUTHORIZE_URL) {
      const clientId = url.searchParams.get("client_id") ?? "";
      const uri = url.searchParams.get("redirect_uri") ?? "";
      if (!clients.exists(clientId))
        return respond(recordedGoogleResponse("authorize_unknown_client"));
      return respond(
        recordedGoogleResponse(
          clients.registered(clientId, uri)
            ? "authorize_registered_iap_uri"
            : "authorize_unregistered_broker_uri",
        ),
      );
    }
    if (endpoint === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const clientId = form.get("client_id") ?? "";
      if (!clients.exists(clientId)) return respond(recordedGoogleResponse("token_unknown_client"));
      if (!clients.secretValid(clientId, form.get("client_secret") ?? "")) {
        return respond(recordedGoogleResponse("token_wrong_secret"));
      }
      return new Response(VALID_PAIR, { status: 400 });
    }
    if (fallback) return fallback(input, init);
    throw new Error(`recorded Google: no answer for ${endpoint}`);
  }) as typeof fetch;
}
