// SPDX-License-Identifier: MPL-2.0

/**
 * The token endpoint (issue #806): `authorization_code` and
 * `refresh_token` grants for public MCP clients.
 *
 * The access token handed out IS the user's Google access token — the
 * proxy forwards it to the IAP-protected admin, and IAP accepts it only
 * because it was issued to the Google client the Owner allowlisted. The
 * refresh token is Google's, sealed and bound to the MCP client it was
 * issued to, so another client cannot redeem it.
 *
 * Binding checks: a code is redeemed only by the `client_id` and
 * `redirect_uri` it was issued for (RFC 6749 §4.1.3), and only with the
 * PKCE verifier — which Google checks against the challenge it got at
 * /authorize. A code replay fails at Google (its code is single use).
 */

import { z } from "zod";
import { readBodyWithCap } from "../middleware/body-cap.js";
import { CodeSealSchema } from "./authorize.js";
import { type McpContext, resourceUrls } from "./context.js";
import { exchangeGoogleCode, type GoogleTokenResult, refreshGoogleToken } from "./google.js";
import { json, oauthError } from "./http.js";
import { open, seal } from "./seal.js";

const TOKEN_MAX_BYTES = 16 * 1024;

/** RFC 7636 §4.1 code_verifier. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Payload of the sealed refresh token. */
export const RefreshSealSchema = z.strictObject({
  google_refresh_token: z.string(),
  client_id: z.string(),
  iat: z.number().int(),
});

const Common = {
  client_id: z.string().min(1).max(8192),
  resource: z.string().max(2048).optional(),
  scope: z.string().max(1024).optional(),
};

const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1).max(8192),
    redirect_uri: z.string().min(1).max(2048),
    code_verifier: z.string().max(256).optional(),
    ...Common,
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1).max(8192),
    ...Common,
  }),
]);

function tokenResponse(
  result: Extract<GoogleTokenResult, { ok: true }>,
  refreshToken: string | null,
): Response {
  const t = result.tokens;
  return json({
    access_token: t.access_token,
    token_type: "Bearer",
    expires_in: t.expires_in,
    ...(refreshToken !== null ? { refresh_token: refreshToken } : {}),
    ...(t.scope !== undefined ? { scope: t.scope } : {}),
  });
}

function googleFailure(result: Extract<GoogleTokenResult, { ok: false }>, what: string): Response {
  if (result.kind === "invalid_grant") {
    return oauthError("invalid_grant", `${what} is invalid, expired or revoked; sign in again`);
  }
  // Never the token or code: status + Google's error code only.
  console.error(`[api-gateway] mcp oauth: Google ${what} call failed (${result.detail})`);
  return oauthError(
    "temporarily_unavailable",
    "Google sign-in is unavailable for this site right now. If it persists, an Owner checks the Google OAuth client under Settings → MCP.",
    503,
  );
}

/** POST /api/mcp/oauth/token */
export async function handleToken(req: Request, ctx: McpContext): Promise<Response> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get("content-type") ?? "")) {
    return oauthError(
      "invalid_request",
      "send the token request as application/x-www-form-urlencoded",
    );
  }
  // Public clients only (AS metadata: token_endpoint_auth_methods_supported
  // ["none"]). A client that authenticates anyway picked a method outside
  // what was advertised; refusing it is what RFC 6749 §2.3 expects.
  if (req.headers.get("authorization")) {
    return oauthError(
      "invalid_client",
      "this server only supports public clients (no client authentication)",
      401,
    );
  }
  const body = await readBodyWithCap(req, TOKEN_MAX_BYTES);
  if (!body.ok) return oauthError("invalid_request", "token request too large", 413);
  const form = new URLSearchParams(new TextDecoder().decode(body.body));
  const fields: Record<string, string> = {};
  for (const [k, v] of form) {
    if (k in fields) return oauthError("invalid_request", `parameter ${k} was sent more than once`);
    fields[k] = v;
  }
  if (fields.client_secret || fields.client_assertion || fields.client_assertion_type) {
    return oauthError(
      "invalid_client",
      "this server only supports public clients (no client authentication)",
      401,
    );
  }
  if (fields.grant_type !== "authorization_code" && fields.grant_type !== "refresh_token") {
    return oauthError(
      "unsupported_grant_type",
      "grant_type must be authorization_code or refresh_token",
    );
  }
  const parsed = TokenRequest.safeParse(fields);
  if (!parsed.success) {
    return oauthError(
      "invalid_request",
      fields.grant_type === "authorization_code"
        ? "authorization_code needs code, redirect_uri, client_id and code_verifier"
        : "refresh_token needs refresh_token and client_id",
    );
  }
  const r = parsed.data;
  if (r.resource !== undefined && !resourceUrls(ctx.config).includes(r.resource)) {
    return oauthError(
      "invalid_target",
      "resource must be this site's /api/mcp/chat or /api/mcp/admin URL",
    );
  }
  const now = ctx.nowSeconds();

  if (r.grant_type === "authorization_code") {
    if (r.code_verifier === undefined || !CODE_VERIFIER.test(r.code_verifier)) {
      return oauthError(
        "invalid_request",
        "PKCE is required: send the code_verifier (43–128 characters)",
      );
    }
    const code = open(ctx.config.sealKey, "code", r.code, CodeSealSchema, now);
    if (!code.ok)
      return oauthError("invalid_grant", "the authorization code is invalid or expired");
    if (code.value.client_id !== r.client_id || code.value.redirect_uri !== r.redirect_uri) {
      return oauthError(
        "invalid_grant",
        "the authorization code was issued to a different client or redirect_uri",
      );
    }
    if (
      r.resource !== undefined &&
      code.value.resource !== null &&
      r.resource !== code.value.resource
    ) {
      return oauthError(
        "invalid_target",
        "resource differs from the one the authorization was for",
      );
    }
    const result = await exchangeGoogleCode(ctx.fetchImpl, {
      google: ctx.config.google,
      publicUrl: ctx.config.publicUrl,
      code: code.value.google_code,
      codeVerifier: r.code_verifier,
    });
    if (!result.ok) return googleFailure(result, "authorization code");
    const refresh =
      result.tokens.refresh_token !== undefined
        ? seal(ctx.config.sealKey, "refresh", {
            google_refresh_token: result.tokens.refresh_token,
            client_id: r.client_id,
            iat: now,
          })
        : null;
    return tokenResponse(result, refresh);
  }

  const sealed = open(ctx.config.sealKey, "refresh", r.refresh_token, RefreshSealSchema, now);
  if (!sealed.ok) return oauthError("invalid_grant", "the refresh token is invalid; sign in again");
  if (sealed.value.client_id !== r.client_id) {
    return oauthError("invalid_grant", "the refresh token was issued to a different client");
  }
  const result = await refreshGoogleToken(ctx.fetchImpl, {
    google: ctx.config.google,
    refreshToken: sealed.value.google_refresh_token,
  });
  if (!result.ok) return googleFailure(result, "refresh token");
  // Google normally keeps the refresh token; when it rotates, seal the new one.
  const refresh =
    result.tokens.refresh_token !== undefined
      ? seal(ctx.config.sealKey, "refresh", {
          google_refresh_token: result.tokens.refresh_token,
          client_id: r.client_id,
          iat: now,
        })
      : r.refresh_token;
  return tokenResponse(result, refresh);
}
