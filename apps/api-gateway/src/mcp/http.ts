// SPDX-License-Identifier: MPL-2.0

/**
 * Response helpers shared by the remote-MCP routes (issue #806): JSON
 * bodies, RFC 6749 error bodies and the CORS headers browser-based MCP
 * clients need.
 *
 * CORS is `*` on purpose: every MCP and OAuth endpoint here authenticates
 * with a bearer token or a sealed value in the request, never with a
 * cookie, so a cross-origin page gains nothing a non-browser client lacks.
 */

/** Request headers a browser-based MCP client may send. */
const CORS_ALLOW_HEADERS =
  "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id";

/** Response headers a browser-based MCP client must be able to read. */
const CORS_EXPOSE_HEADERS = "mcp-session-id, www-authenticate";

/** Add the CORS headers every MCP response carries. */
export function withCors(headers: Headers): Headers {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  return headers;
}

/** The answer to a CORS preflight on an MCP or OAuth endpoint. */
export function corsPreflight(): Response {
  const headers = withCors(new Headers());
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
  headers.set("access-control-max-age", "600");
  return new Response(null, { status: 204, headers });
}

/** A JSON response with CORS and `no-store` (tokens and metadata must not sit in shared caches). */
export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers = withCors(new Headers(extra));
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  return new Response(JSON.stringify(body), { status, headers });
}

/** RFC 6749 §5.2 error codes (+ RFC 7591 / RFC 8707 ones) this broker answers with. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable";

/** An RFC 6749 JSON error. `description` is for the developer; it never holds a token or secret. */
export function oauthError(
  error: OAuthErrorCode,
  description: string,
  status = 400,
  extra?: Record<string, string>,
): Response {
  return json({ error, error_description: description }, status, extra);
}

/**
 * An error the authorization endpoint cannot redirect (unknown client, a
 * redirect URI that is not the client's): RFC 6749 §4.1.2.1 forbids
 * redirecting then, so the user's browser gets a plain page.
 */
export function authorizePageError(description: string, status = 400): Response {
  return new Response(
    `Caelo could not start the sign-in: ${description}\n\nGo back to your AI app and connect again. If it keeps failing, the app's sign-in settings do not match this Caelo site.\n`,
    {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
