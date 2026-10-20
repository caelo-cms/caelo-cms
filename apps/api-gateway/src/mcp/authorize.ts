// SPDX-License-Identifier: MPL-2.0

/**
 * The authorization endpoint, the user's consent, and Google's callback
 * (issue #806).
 *
 *   MCP client ──GET /authorize──▶ broker: consent page (sets binding cookie)
 *   user ──POST /authorize (Approve)──▶ broker ──302──▶ Google sign-in
 *   Google ──/google-callback?code&state──▶ broker ──302──▶ client redirect_uri?code&state&iss
 *
 * Stateless: what the broker must remember between the hops rides in the
 * sealed consent token (10 min), the sealed Google `state` (10 min) and
 * the sealed `code` it hands the client (5 min); the one thing tied to the
 * user's browser is the consent cookie (consent.ts explains the binding).
 * The client's PKCE challenge is sealed along the way so /token checks the
 * verifier itself, and it is also sent to Google, which checks it again.
 *
 * RFC 6749 §4.1.2.1: as long as the client or its redirect URI is not
 * established, errors are shown to the user and never redirected. After
 * that, every authorization response — success or error — carries `iss`
 * (RFC 9207), because the AS metadata advertises it and ChatGPT rejects a
 * response without it.
 */

import { z } from "zod";
import { readBodyWithCap } from "../middleware/body-cap.js";
import {
  CONSENT_TTL_SECONDS,
  clearBindingCookie,
  consentPage,
  newBinding,
  requestHoldsBinding,
} from "./consent.js";
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

/**
 * An S256 challenge: base64url (no padding) of a SHA-256 is exactly 43
 * characters (RFC 7636 §4.2). `plain` is refused, so nothing else is valid.
 */
export const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Largest Approve/Deny form accepted (one sealed token + one word). */
const DECISION_MAX_BYTES = 16 * 1024;

const OptionalParam = (max: number) => z.string().max(max).optional();

const AuthorizeQuery = z.object({
  response_type: OptionalParam(64),
  client_id: z.string().min(1).max(8192),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: OptionalParam(256),
  code_challenge_method: OptionalParam(32),
  state: OptionalParam(1024),
  scope: OptionalParam(1024),
  resource: OptionalParam(2048),
});

const Binding = { binding_id: z.string(), binding_nonce: z.string() };

/** Payload of the sealed consent token embedded in the consent page. */
export const ConsentSealSchema = z.strictObject({
  client_id: z.string(),
  redirect_uri: z.string(),
  client_state: z.string().nullable(),
  resource: z.string().nullable(),
  code_challenge: z.string(),
  ...Binding,
  exp: z.number().int(),
});

/** Payload of the sealed Google `state`. */
export const StateSealSchema = z.strictObject({
  client_id: z.string(),
  redirect_uri: z.string(),
  client_state: z.string().nullable(),
  resource: z.string().nullable(),
  code_challenge: z.string(),
  ...Binding,
  exp: z.number().int(),
});

/** Payload of the sealed authorization code. */
export const CodeSealSchema = z.strictObject({
  google_code: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  resource: z.string().nullable(),
  code_challenge: z.string(),
  exp: z.number().int(),
});

/** The parameters as one string each (a repeated parameter is refused, not guessed). */
function singleParams(params: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k in out) return null;
    out[k] = v;
  }
  return out;
}

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

/**
 * 302 to the client's redirect URI with `params` and `iss`. The URI was
 * matched against the client and the allowlist before this is called.
 */
export function redirectToClient(
  ctx: McpContext,
  redirectUri: string,
  params: Record<string, string | null>,
  setCookie?: string,
): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null) url.searchParams.set(k, v);
  }
  url.searchParams.set("iss", issuer(ctx.config));
  const headers = new Headers({ location: url.toString(), ...NO_STORE });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

function errorRedirect(
  ctx: McpContext,
  redirectUri: string,
  clientState: string | null,
  error: OAuthErrorCode,
  description: string,
  setCookie?: string,
): Response {
  return redirectToClient(
    ctx,
    redirectUri,
    { error, error_description: description, state: clientState },
    setCookie,
  );
}

/** GET /api/mcp/oauth/authorize — validate the request, then ask the user. */
export async function handleAuthorize(req: Request, ctx: McpContext): Promise<Response> {
  const params = singleParams(new URL(req.url).searchParams);
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
  if (!S256_CHALLENGE.test(q.code_challenge)) {
    return fail(
      "invalid_request",
      "code_challenge is not a valid S256 challenge (43 base64url characters)",
    );
  }
  if (q.resource !== undefined && !resourceUrls(ctx.config).includes(q.resource)) {
    return fail(
      "invalid_target",
      "resource must be this site's /api/mcp/chat or /api/mcp/admin URL",
    );
  }

  const binding = newBinding();
  const consentToken = seal(ctx.config.sealKey, "consent", {
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    client_state: clientState,
    resource: q.resource ?? null,
    code_challenge: q.code_challenge,
    binding_id: binding.id,
    binding_nonce: binding.nonce,
    exp: ctx.nowSeconds() + CONSENT_TTL_SECONDS,
  });
  return consentPage({
    config: ctx.config,
    clientName: client.client.clientName,
    redirectUri: q.redirect_uri,
    resource: q.resource ?? null,
    consentToken,
    binding,
  });
}

const DecisionForm = z.strictObject({
  consent: z.string().min(1).max(8192),
  decision: z.enum(["approve", "deny"]),
});

/**
 * POST /api/mcp/oauth/authorize — the consent page's Approve / Deny.
 *
 * Refused (400 page, no redirect) unless the consent token is genuine and
 * unexpired AND this browser holds its cookie: without both, nobody can
 * say the user saw the page.
 */
export async function handleAuthorizeDecision(req: Request, ctx: McpContext): Promise<Response> {
  // Browsers send Origin on a form POST (the page's same-origin referrer
  // policy keeps it from being "null"); one naming another site is not our
  // consent page. The cookie check below is what actually decides; this
  // only refuses the obvious case early. "null" (privacy modes) is left to
  // the cookie check rather than refused, so it cannot lock users out.
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== "null" && origin !== ctx.config.publicUrl) {
    return authorizePageError("the approval did not come from this site's consent page");
  }
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get("content-type") ?? "")) {
    return authorizePageError("the approval was not sent by this site's consent page");
  }
  const body = await readBodyWithCap(req, DECISION_MAX_BYTES);
  if (!body.ok) return authorizePageError("the approval is too large", 413);
  const fields = singleParams(new URLSearchParams(new TextDecoder().decode(body.body)));
  const parsed = fields ? DecisionForm.safeParse(fields) : null;
  if (!parsed?.success) return authorizePageError("the approval is incomplete");
  const opened = open(
    ctx.config.openKeys,
    "consent",
    parsed.data.consent,
    ConsentSealSchema,
    ctx.nowSeconds(),
  );
  if (!opened.ok) {
    return authorizePageError(
      opened.reason === "expired"
        ? "the approval page was open for more than 10 minutes"
        : "the approval does not belong to a sign-in this site started",
    );
  }
  const c = opened.value;
  if (!requestHoldsBinding(req, c.binding_id, c.binding_nonce)) {
    return authorizePageError(
      "the approval did not come from the browser that opened the consent page (cookies blocked?)",
    );
  }
  if (parsed.data.decision === "deny") {
    return errorRedirect(
      ctx,
      c.redirect_uri,
      c.client_state,
      "access_denied",
      "the user denied the connection",
      clearBindingCookie(c.binding_id),
    );
  }
  const state = seal(ctx.config.sealKey, "state", {
    client_id: c.client_id,
    redirect_uri: c.redirect_uri,
    client_state: c.client_state,
    resource: c.resource,
    code_challenge: c.code_challenge,
    binding_id: c.binding_id,
    binding_nonce: c.binding_nonce,
    exp: ctx.nowSeconds() + STATE_TTL_SECONDS,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: googleAuthorizeUrl({
        google: ctx.config.google,
        publicUrl: ctx.config.publicUrl,
        codeChallenge: c.code_challenge,
        state,
      }),
      ...NO_STORE,
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
  const params = singleParams(new URL(req.url).searchParams);
  const parsed = params ? CallbackQuery.safeParse(params) : null;
  if (!parsed?.success) return authorizePageError("the sign-in response from Google is incomplete");
  const opened = open(
    ctx.config.openKeys,
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
  // The sign-in must finish in the browser that approved it: otherwise a
  // state minted for someone else's approval could be completed here.
  if (!requestHoldsBinding(req, st.binding_id, st.binding_nonce)) {
    return authorizePageError(
      "the sign-in was not approved in this browser. Start connecting again from your AI app",
    );
  }
  const clear = clearBindingCookie(st.binding_id);
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
      clear,
    );
  }
  const code = seal(ctx.config.sealKey, "code", {
    google_code: parsed.data.code,
    client_id: st.client_id,
    redirect_uri: st.redirect_uri,
    resource: st.resource,
    code_challenge: st.code_challenge,
    exp: ctx.nowSeconds() + CODE_TTL_SECONDS,
  });
  return redirectToClient(ctx, st.redirect_uri, { code, state: st.client_state }, clear);
}
