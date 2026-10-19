// SPDX-License-Identifier: MPL-2.0

/**
 * The authorization endpoint and Google's callback (issue #806).
 *
 *   MCP client ──/authorize──▶ broker ──302──▶ Google sign-in
 *   Google ──/google-callback?code&state──▶ broker ──302──▶ client redirect_uri?code&state&iss
 *
 * Stateless: what the broker must remember between the two hops rides in
 * the sealed Google `state` (10 min), and what it must remember until
 * /token rides in the sealed `code` it hands the client (5 min). The
 * client's PKCE challenge goes to Google unchanged, so Google checks the
 * verifier at the exchange.
 *
 * RFC 6749 §4.1.2.1: as long as the client or its redirect URI is not
 * established, errors are shown to the user and never redirected. After
 * that, every authorization response — success or error — carries `iss`
 * (RFC 9207), because the AS metadata advertises it and ChatGPT rejects a
 * response without it.
 */

import { z } from "zod";
import type { McpContext } from "./context.js";
import { issuer, resourceUrls } from "./context.js";
import { googleAuthorizeUrl } from "./google.js";
import { authorizePageError, type OAuthErrorCode } from "./http.js";
import { redirectUriMatches } from "./redirect-allowlist.js";
import { resolveClient } from "./registration.js";
import { open, seal } from "./seal.js";

/** Lifetime of the sealed Google `state`. */
export const STATE_TTL_SECONDS = 10 * 60;
/** Lifetime of the sealed authorization code handed to the MCP client. */
export const CODE_TTL_SECONDS = 5 * 60;

/** RFC 7636 §4.2: base64url of a SHA-256, 43 chars; the full allowed range is 43–128. */
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

const OptionalParam = (max: number) => z.string().max(max).optional();

const AuthorizeQuery = z.object({
  response_type: OptionalParam(64),
  client_id: z.string().min(1).max(8192),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: OptionalParam(256),
  code_challenge_method: OptionalParam(32),
  state: OptionalParam(2048),
  scope: OptionalParam(1024),
  resource: OptionalParam(2048),
});

/** Payload of the sealed Google `state`. */
export const StateSealSchema = z.strictObject({
  client_id: z.string(),
  redirect_uri: z.string(),
  client_state: z.string().nullable(),
  resource: z.string().nullable(),
  exp: z.number().int(),
});

/** Payload of the sealed authorization code. */
export const CodeSealSchema = z.strictObject({
  google_code: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  resource: z.string().nullable(),
  exp: z.number().int(),
});

/** The query parameters as one string each (a repeated parameter is refused, not guessed). */
function singleParams(url: URL): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k in out) return null;
    out[k] = v;
  }
  return out;
}

/**
 * 302 to the client's redirect URI with `params` and `iss`. The URI was
 * matched against the client and the allowlist before this is called.
 */
export function redirectToClient(
  ctx: McpContext,
  redirectUri: string,
  params: Record<string, string | null>,
): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null) url.searchParams.set(k, v);
  }
  url.searchParams.set("iss", issuer(ctx.config));
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function errorRedirect(
  ctx: McpContext,
  redirectUri: string,
  clientState: string | null,
  error: OAuthErrorCode,
  description: string,
): Response {
  return redirectToClient(ctx, redirectUri, {
    error,
    error_description: description,
    state: clientState,
  });
}

/** GET /api/mcp/oauth/authorize */
export async function handleAuthorize(req: Request, ctx: McpContext): Promise<Response> {
  const params = singleParams(new URL(req.url));
  if (!params) return authorizePageError("a parameter was sent more than once");
  const parsed = AuthorizeQuery.safeParse(params);
  if (!parsed.success) return authorizePageError("client_id and redirect_uri are required");
  const q = parsed.data;

  const client = await resolveClient(ctx, q.client_id);
  if (!client.ok) return authorizePageError(client.message);
  if (!redirectUriMatches(q.redirect_uri, client.client.redirectUris)) {
    return authorizePageError("the redirect_uri is not registered for this client");
  }

  // From here on the redirect URI is trusted: errors go back to the client.
  const clientState = q.state ?? null;
  const fail = (error: OAuthErrorCode, description: string) =>
    errorRedirect(ctx, q.redirect_uri, clientState, error, description);

  if (q.response_type !== "code") {
    return fail("unsupported_response_type", 'response_type must be "code"');
  }
  if (q.code_challenge === undefined || q.code_challenge_method === undefined) {
    return fail(
      "invalid_request",
      "PKCE is required: send code_challenge with code_challenge_method=S256",
    );
  }
  if (q.code_challenge_method !== "S256") {
    return fail("invalid_request", "only code_challenge_method=S256 is supported");
  }
  if (!PKCE_VALUE.test(q.code_challenge)) {
    return fail("invalid_request", "code_challenge is not a valid S256 challenge");
  }
  if (q.resource !== undefined && !resourceUrls(ctx.config).includes(q.resource)) {
    return fail(
      "invalid_target",
      "resource must be this site's /api/mcp/chat or /api/mcp/admin URL",
    );
  }

  const state = seal(ctx.config.sealKey, "state", {
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    client_state: clientState,
    resource: q.resource ?? null,
    exp: ctx.nowSeconds() + STATE_TTL_SECONDS,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: googleAuthorizeUrl({
        google: ctx.config.google,
        publicUrl: ctx.config.publicUrl,
        codeChallenge: q.code_challenge,
        state,
      }),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

const CallbackQuery = z.object({
  state: z.string().min(1).max(8192),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().max(128).optional(),
});

/** Google errors forwarded by name; anything else becomes `server_error`. */
const FORWARDED_GOOGLE_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "invalid_scope",
  "temporarily_unavailable",
]);

/** GET /api/mcp/oauth/google-callback */
export function handleGoogleCallback(req: Request, ctx: McpContext): Response {
  const params = singleParams(new URL(req.url));
  const parsed = params ? CallbackQuery.safeParse(params) : null;
  if (!parsed?.success) return authorizePageError("the sign-in response from Google is incomplete");
  const opened = open(
    ctx.config.sealKey,
    "state",
    parsed.data.state,
    StateSealSchema,
    ctx.nowSeconds(),
  );
  if (!opened.ok) {
    return authorizePageError(
      opened.reason === "expired"
        ? "the sign-in took longer than 10 minutes"
        : "the sign-in response does not belong to a sign-in this site started",
    );
  }
  const st = opened.value;
  if (parsed.data.error !== undefined || parsed.data.code === undefined) {
    const googleError = parsed.data.error ?? "server_error";
    const error = (
      FORWARDED_GOOGLE_ERRORS.has(googleError) ? googleError : "server_error"
    ) as OAuthErrorCode;
    return errorRedirect(
      ctx,
      st.redirect_uri,
      st.client_state,
      error,
      "Google sign-in did not complete",
    );
  }
  const code = seal(ctx.config.sealKey, "code", {
    google_code: parsed.data.code,
    client_id: st.client_id,
    redirect_uri: st.redirect_uri,
    resource: st.resource,
    exp: ctx.nowSeconds() + CODE_TTL_SECONDS,
  });
  return redirectToClient(ctx, st.redirect_uri, { code, state: st.client_state });
}
