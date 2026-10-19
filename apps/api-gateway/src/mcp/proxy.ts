// SPDX-License-Identifier: MPL-2.0

/**
 * The MCP endpoints (issue #806): `/api/mcp/<surface>` → the IAP-protected
 * admin's `/api/mcp/remote/<surface>`, streamed both ways (MCP Streamable
 * HTTP answers with SSE that can stay open for minutes).
 *
 * The broker holds no admin credential. What reaches the admin is the
 * user's own Google bearer token, and IAP decides: a token not issued to
 * the allowlisted client → IAP 401 (the client signs in again); a user
 * without access → IAP 403 (told to ask the Owner). The admin then reads
 * the user from IAP's signed `x-goog-iap-jwt-assertion`.
 *
 * Headers are forwarded by allowlist, never by denylist: an inbound
 * `x-goog-iap-jwt-assertion`, `x-caelo-*`, `cookie` or `x-forwarded-*`
 * would otherwise be one header away from impersonating IAP or the
 * admin's own plumbing (IAP overwrites its own headers too — this is the
 * second line).
 */

import type { McpSurface } from "./config.js";
import type { McpContext } from "./context.js";
import { resourceMetadataUrl } from "./context.js";
import { json, withCors } from "./http.js";

/** Request headers the admin may see from an MCP client. */
export const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "user-agent",
];

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Response headers never passed back to the MCP client. */
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  // The admin's (or IAP's) cookies belong to the admin origin, not to this one.
  "set-cookie",
  "x-goog-iap-generated-response",
  // Recomputed by Bun from the streamed body.
  "content-length",
]);

/** The `WWW-Authenticate` challenge that starts (or restarts) the OAuth flow. */
export function bearerChallenge(
  ctx: McpContext,
  surface: McpSurface,
  invalidToken: boolean,
): string {
  const base = `Bearer resource_metadata="${resourceMetadataUrl(ctx.config, surface)}"`;
  return invalidToken ? `${base}, error="invalid_token"` : base;
}

function unauthorized(ctx: McpContext, surface: McpSurface, invalidToken: boolean): Response {
  return json(
    {
      error: invalidToken ? "invalid_token" : "unauthorized",
      message: "Sign in with your Google account to use this Caelo site from your AI app.",
    },
    401,
    { "www-authenticate": bearerChallenge(ctx, surface, invalidToken) },
  );
}

/** The headers sent upstream: only the allowlist, plus fresh forwarding facts. */
export function upstreamRequestHeaders(req: Request, ctx: McpContext): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const pub = new URL(ctx.config.publicUrl);
  headers.set("x-forwarded-host", pub.host);
  headers.set("x-forwarded-proto", pub.protocol.replace(":", ""));
  // Uncompressed from the admin: a compressing hop in between would buffer
  // SSE events, and the client's own Accept-Encoding is not forwarded.
  headers.set("accept-encoding", "identity");
  return headers;
}

/**
 * Serve one MCP request for `surface`.
 *
 * @param disableIdleTimeout - turns off Bun's per-request idle timeout
 *   (10 s by default), which would cut an SSE stream that is quiet
 *   between events.
 */
export async function handleMcpProxy(
  req: Request,
  ctx: McpContext,
  surface: McpSurface,
  disableIdleTimeout: () => void,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    return json({ error: "method_not_allowed", message: "use GET, POST or DELETE" }, 405, {
      allow: "GET, POST, DELETE, OPTIONS",
    });
  }
  const auth = req.headers.get("authorization");
  if (!auth || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(auth)) {
    return unauthorized(ctx, surface, auth !== null);
  }
  disableIdleTimeout();
  const target = `${ctx.config.adminUrl}/api/mcp/remote/${surface}`;
  const hasBody = req.method === "POST";
  let upstream: Response;
  try {
    upstream = await ctx.fetchImpl(target, {
      method: req.method,
      headers: upstreamRequestHeaders(req, ctx),
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
      // Pass the admin's bytes through untouched; SSE must not be buffered by a decoder.
      decompress: false,
      // The client hanging up ends the upstream request too.
      signal: req.signal,
    } as RequestInit);
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error(
      `[api-gateway] mcp proxy: admin unreachable (${e instanceof Error ? e.name : "fetch failed"})`,
    );
    return json(
      {
        error: "admin_unreachable",
        message: "The Caelo admin could not be reached. Try again in a moment.",
      },
      502,
    );
  }
  if (upstream.headers.has("x-goog-iap-generated-response")) {
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      return unauthorized(ctx, surface, true);
    }
    if (upstream.status === 403) {
      await upstream.body?.cancel();
      return json(
        {
          error: "not_a_caelo_user",
          message:
            "This Google account has no access to this Caelo site. Ask the site Owner to add you under Settings → Users.",
        },
        403,
      );
    }
  }
  const headers = withCors(new Headers());
  for (const [name, value] of upstream.headers) {
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    headers.append(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
