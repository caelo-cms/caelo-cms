// SPDX-License-Identifier: MPL-2.0

/**
 * The token endpoint (issue #806): `authorization_code` and
 * `refresh_token` grants for public MCP clients.
 *
 * The access token handed out IS the user's Google ID token — the proxy
 * forwards it to the IAP-protected admin, and IAP accepts it only because
 * its audience is the Google client the Owner allowlisted (google.ts cites
 * the IAP contract). The refresh token is Google's, sealed and bound to the
 * MCP client and resource it was issued for, so another client cannot
 * redeem it, and it stops working {@link REFRESH_MAX_LIFETIME_SECONDS}
 * after the sign-in that minted it.
 *
 * Binding checks: a code is redeemed only by the `client_id` and
 * `redirect_uri` it was issued for (RFC 6749 §4.1.3), only with the PKCE
 * verifier matching the challenge sealed into it — checked here, before
 * Google is called — and only for the resource it was authorized for
 * (RFC 8707). A code replay fails at Google (its code is single use).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readBodyWithCap } from "../middleware/body-cap.js";
import { CodeSealSchema } from "./authorize.js";
import { type McpContext, resourceUrls } from "./context.js";
import { exchangeGoogleCode, type GoogleTokenResult, refreshGoogleToken } from "./google.js";
import { json, oauthError } from "./http.js";
import { open, seal } from "./seal.js";

const TOKEN_MAX_BYTES = 16 * 1024;

/**
 * How long one sign-in keeps a client connected, counted from the sign-in
 * (`iat`), not from the last refresh. Google refresh tokens for a Web
 * client never expire on their own, so without this cap a leaked sealed
 * refresh token would work until the user revokes the app in their Google
 * account — which few ever do. 30 days matches a monthly re-sign-in, which
 * is the cadence users already know from Google Workspace sessions.
 */
export const REFRESH_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/** RFC 7636 §4.1 code_verifier. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Payload of the sealed refresh token. */
export const RefreshSealSchema = z.strictObject({
  google_refresh_token: z.string(),
  client_id: z.string(),
  /** The resource the sign-in was for; null when the client never named one. */
  resource: z.string().nullable(),
  /** When the sign-in happened; kept across Google refresh-token rotation. */
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
  refreshToken: string,
): Response {
  const t = result.tokens;
  return json({
    access_token: t.idToken,
    token_type: "Bearer",
    expires_in: t.idTokenExpiresIn,
    refresh_token: refreshToken,
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

/** True when `verifier` hashes to the S256 `challenge` (RFC 7636 §4.6), compared in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const got = Buffer.from(createHash("sha256").update(verifier).digest("base64url"), "utf8");
  const want = Buffer.from(challenge, "utf8");
  return got.byteLength === want.byteLength && timingSafeEqual(got, want);
}

/**
 * The resource a grant is for (RFC 8707): the one bound at authorization,
 * else the one this request names. A request naming a different resource
 * than the grant's is `invalid_target` — the grant was approved for the
 * other surface.
 */
function grantResource(
  bound: string | null,
  requested: string | undefined,
): { ok: true; resource: string | null } | { ok: false; response: Response } {
  if (requested !== undefined && bound !== null && requested !== bound) {
    return {
      ok: false,
      response: oauthError(
        "invalid_target",
        "resource differs from the one this grant was authorized for; sign in again for that resource",
      ),
    };
  }
  return { ok: true, resource: bound ?? requested ?? null };
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
    const code = open(ctx.config.openKeys, "code", r.code, CodeSealSchema, now);
    if (!code.ok)
      return oauthError("invalid_grant", "the authorization code is invalid or expired");
    if (code.value.client_id !== r.client_id || code.value.redirect_uri !== r.redirect_uri) {
      return oauthError(
        "invalid_grant",
        "the authorization code was issued to a different client or redirect_uri",
      );
    }
    if (!pkceMatches(r.code_verifier, code.value.code_challenge)) {
      return oauthError(
        "invalid_grant",
        "the code_verifier does not match the code_challenge sent to /authorize",
      );
    }
    const target = grantResource(code.value.resource, r.resource);
    if (!target.ok) return target.response;
    const result = await exchangeGoogleCode(ctx.fetchImpl, {
      google: ctx.config.google,
      publicUrl: ctx.config.publicUrl,
      code: code.value.google_code,
      codeVerifier: r.code_verifier,
      nowSeconds: now,
    });
    if (!result.ok) return googleFailure(result, "authorization code");
    // access_type=offline + prompt=consent always yield one; a sign-in
    // without it could never refresh, so say so instead of half-working.
    if (result.tokens.refreshToken === undefined) {
      return googleFailure(
        { ok: false, kind: "upstream", detail: "no refresh token in the code exchange" },
        "authorization code",
      );
    }
    const refresh = seal(ctx.config.sealKey, "refresh", {
      google_refresh_token: result.tokens.refreshToken,
      client_id: r.client_id,
      resource: target.resource,
      iat: now,
    });
    return tokenResponse(result, refresh);
  }

  const sealed = open(ctx.config.openKeys, "refresh", r.refresh_token, RefreshSealSchema, now);
  if (!sealed.ok) return oauthError("invalid_grant", "the refresh token is invalid; sign in again");
  if (sealed.value.client_id !== r.client_id) {
    return oauthError("invalid_grant", "the refresh token was issued to a different client");
  }
  if (now - sealed.value.iat >= REFRESH_MAX_LIFETIME_SECONDS) {
    return oauthError(
      "invalid_grant",
      "the sign-in is older than 30 days; sign in again to keep this app connected",
    );
  }
  const target = grantResource(sealed.value.resource, r.resource);
  if (!target.ok) return target.response;
  const result = await refreshGoogleToken(ctx.fetchImpl, {
    google: ctx.config.google,
    refreshToken: sealed.value.google_refresh_token,
    nowSeconds: now,
  });
  if (!result.ok) return googleFailure(result, "refresh token");
  // Re-seal on every refresh: Google may rotate its refresh token, a
  // previous-key value moves onto the current key, and the resource a
  // client named only now is bound from here on. `iat` stays the
  // sign-in's, so the 30-day cap cannot be reset by refreshing.
  const refresh = seal(ctx.config.sealKey, "refresh", {
    google_refresh_token: result.tokens.refreshToken ?? sealed.value.google_refresh_token,
    client_id: r.client_id,
    resource: target.resource,
    iat: sealed.value.iat,
  });
  return tokenResponse(result, refresh);
}
