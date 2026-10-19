// SPDX-License-Identifier: MPL-2.0

/**
 * The MCP endpoints (issue #806): `/api/mcp/<surface>` → the IAP-protected
 * admin's `/api/mcp/remote/<surface>`, streamed both ways (MCP Streamable
 * HTTP answers with SSE that can stay open for minutes).
 *
 * The broker holds no admin credential. What reaches the admin is the
 * user's own Google ID token, and IAP decides: a token not issued to the
 * allowlisted client → IAP 401 (the client signs in again); a user
 * without access → IAP 403 (told to ask the Owner). The admin then reads
 * the user from IAP's signed `x-goog-iap-jwt-assertion`.
 *
 * Headers are forwarded by allowlist in both directions, never by
 * denylist: an inbound `x-goog-iap-jwt-assertion`, `x-caelo-*`, `cookie`
 * or `x-forwarded-*` would otherwise be one header away from impersonating
 * IAP or the admin's own plumbing (IAP overwrites its own headers too —
 * this is the second line), and an outbound `set-cookie`, `location`,
 * `server` or `via` would leak the admin origin's plumbing into this one.
 *
 * Timeouts: Bun cuts a request whose socket is idle for its idle timeout.
 * The proxy keeps that timeout at {@link ProxyLimits.firstResponseTimeoutMs}
 * while waiting for the admin's headers (and aborts the upstream request
 * itself at that point, answering 504), and lifts it only once the admin
 * answered 2xx `text/event-stream` — the one response that may then stay
 * quiet between events. An unauthenticated or refused request never holds
 * a connection open. The admin's remote endpoint therefore answers a long
 * tool call as an SSE stream (Streamable HTTP's streaming response), not
 * as one JSON body after minutes.
 */

import type { McpSurface } from "./config.js";
import type { McpContext, ProxyLimits } from "./context.js";
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

/** Response headers the MCP client may see from the admin. */
export const FORWARDED_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
];

/**
 * How long the admin may take to send its response headers. 30 s covers a
 * cold start of the scale-to-zero admin (§11.B) with room to spare; a tool
 * call that runs longer streams its result as SSE, which answers headers
 * immediately.
 */
export const FIRST_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Largest MCP request body forwarded. Sized for the biggest legitimate
 * call: `caelo_upload_images` (packages/mcp-server/src/image-upload.ts)
 * takes up to 4 images of 5 MiB each as base64 — 4 × ⌈5 MiB / 3⌉ × 4 bytes
 * ≈ 26.7 MiB — plus 1 MiB for the JSON-RPC envelope and the other fields.
 */
export const MAX_PROXY_BODY_BYTES = 4 * Math.ceil((5 * 1024 * 1024) / 3) * 4 + 1024 * 1024;

/** The production limits. */
export const PROXY_LIMITS: ProxyLimits = {
  firstResponseTimeoutMs: FIRST_RESPONSE_TIMEOUT_MS,
  maxBodyBytes: MAX_PROXY_BODY_BYTES,
};

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

function tooLarge(limit: number): Response {
  return json(
    {
      error: "request_too_large",
      message: `MCP requests are limited to ${Math.floor(limit / (1024 * 1024))} MiB. Upload fewer images per call.`,
    },
    413,
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

/** The request body, erroring the stream as soon as it passes `limit` bytes. */
function cappedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  onExceeded: () => void,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) {
          onExceeded();
          controller.error(new RangeError("MCP request body over the cap"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Per-request facts the proxy needs from the server. */
export interface ProxyHooks {
  /** Set Bun's idle timeout for this request, in seconds (0 = none). */
  readonly setIdleTimeout: (seconds: number) => void;
}

/** Serve one MCP request for `surface`. */
export async function handleMcpProxy(
  req: Request,
  ctx: McpContext,
  surface: McpSurface,
  hooks: ProxyHooks,
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
  const limits = ctx.proxyLimits;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limits.maxBodyBytes) {
    return tooLarge(limits.maxBodyBytes);
  }
  let overCap = false;
  const body =
    req.method === "POST" && req.body
      ? cappedBody(req.body, limits.maxBodyBytes, () => {
          overCap = true;
        })
      : null;

  // Bun's idle timeout must not fire before the proxy's own first-response
  // timeout does (Bun takes whole seconds, at most 255).
  hooks.setIdleTimeout(Math.min(255, Math.ceil(limits.firstResponseTimeoutMs / 1000) + 1));
  const firstResponse = new AbortController();
  const timer = setTimeout(() => firstResponse.abort(), limits.firstResponseTimeoutMs);
  const target = `${ctx.config.adminUrl}/api/mcp/remote/${surface}`;
  let upstream: Response;
  try {
    upstream = await ctx.fetchImpl(target, {
      method: req.method,
      headers: upstreamRequestHeaders(req, ctx),
      ...(body ? { body, duplex: "half" } : {}),
      redirect: "manual",
      // Pass the admin's bytes through untouched; SSE must not be buffered by a decoder.
      decompress: false,
      // The client hanging up ends the upstream request too; so does an
      // admin that does not answer in time. The timer is cleared below, so
      // after the headers only the client can end the stream.
      signal: AbortSignal.any([req.signal, firstResponse.signal]),
    } as RequestInit);
  } catch (e) {
    if (overCap) return tooLarge(limits.maxBodyBytes);
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (firstResponse.signal.aborted) {
      console.error("[api-gateway] mcp proxy: admin did not answer in time");
      return json(
        {
          error: "admin_timeout",
          message: "The Caelo admin did not answer in time. Try again in a moment.",
        },
        504,
      );
    }
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
  } finally {
    clearTimeout(timer);
  }
  if (overCap) {
    await upstream.body?.cancel();
    return tooLarge(limits.maxBodyBytes);
  }
  // Any 401 — IAP's or the admin's own — means "this bearer is no good":
  // answer with this resource's challenge so the client re-runs OAuth
  // against the broker, never with a challenge naming the admin origin.
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    return unauthorized(ctx, surface, true);
  }
  if (upstream.status === 403 && upstream.headers.has("x-goog-iap-generated-response")) {
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
  const isStream =
    upstream.ok &&
    !upstream.headers.has("x-goog-iap-generated-response") &&
    /^text\/event-stream\b/i.test(upstream.headers.get("content-type") ?? "");
  if (isStream) hooks.setIdleTimeout(0);
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: withCors(headers),
  });
}
