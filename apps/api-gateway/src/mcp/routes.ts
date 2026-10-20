// SPDX-License-Identifier: MPL-2.0

/**
 * Remote MCP on the public gateway (issue #806): the OAuth broker and the
 * streaming proxy to the IAP-protected admin, as one router `server.ts`
 * consults before its database-backed plugin pipeline.
 *
 * Nothing here touches a database or admin-only code (the gateway
 * boundary, docs/dev/public-admin-boundary.md): configuration is env plus
 * one secret-volume file, every value the broker must remember is sealed
 * into what it hands the client, and the per-address rate limits are
 * in-process (rate-limit.ts says why).
 *
 * Routes (all under the public origin `CAELO_MCP_PUBLIC_URL`):
 *
 *   GET|POST|DELETE /api/mcp/{chat,admin}                     proxy.ts
 *   GET  /.well-known/oauth-protected-resource/api/mcp/{s}     metadata.ts
 *   GET  /api/mcp/oauth/protected-resource/{s}                 metadata.ts
 *   GET  (two AS-metadata variants)                            metadata.ts
 *   GET  /api/mcp/oauth/authorize          consent page        authorize.ts
 *   POST /api/mcp/oauth/authorize          Approve / Deny      authorize.ts
 *   GET  /api/mcp/oauth/google-callback                        authorize.ts
 *   POST /api/mcp/oauth/token                                  token.ts
 *   POST /api/mcp/oauth/register                               registration.ts
 *   GET  /api/mcp/oauth/status                                 setup self-check
 */

import { handleAuthorize, handleAuthorizeDecision, handleGoogleCallback } from "./authorize.js";
import {
  McpConfigLoader,
  type McpSurface,
  notConfiguredResponse,
  type ReadTextFile,
} from "./config.js";
import type { McpContext, ProxyLimits } from "./context.js";
import { corsPreflight, json } from "./http.js";
import {
  AS_METADATA_PATHS,
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceSurface,
} from "./metadata.js";
import { handleMcpProxy, PROXY_LIMITS } from "./proxy.js";
import {
  type BucketSpec,
  MCP_RATE_LIMITS,
  type McpRateClass,
  McpRateLimiter,
} from "./rate-limit.js";
import { CimdCache, handleRegister } from "./registration.js";
import { handleToken } from "./token.js";

/** Effects and limits the router uses; all default to the real ones. */
export interface McpRouterDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: ReadTextFile;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly rateLimits?: Record<McpRateClass, BucketSpec>;
  readonly proxyLimits?: ProxyLimits;
}

/** Per-request facts only the server knows. */
export interface McpRequestHooks {
  /** The client's address under the deployment's proxy topology (client-ip.ts). */
  readonly clientAddress: string;
  /** Set Bun's idle timeout for this request, in seconds (`server.timeout(req, s)`; 0 = none). */
  readonly setIdleTimeout: (seconds: number) => void;
}

/** A router: a Response for a remote-MCP path, null for anything else. */
export type McpRouter = (req: Request, hooks: McpRequestHooks) => Promise<Response | null>;

const OAUTH_PREFIX = "/api/mcp/oauth/";
const MCP_ENDPOINT = /^\/api\/mcp\/(chat|admin)$/;

/** True when `pathname` belongs to remote MCP. */
export function isMcpPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/mcp/") ||
    pathname.startsWith("/.well-known/oauth-protected-resource/api/mcp/") ||
    AS_METADATA_PATHS.includes(pathname)
  );
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed", message: `use ${allow}` }, 405, { allow });
}

/** The rate-limit class of a remote-MCP path. */
function rateClass(pathname: string): McpRateClass {
  if (MCP_ENDPOINT.test(pathname)) return "proxy";
  switch (pathname) {
    case `${OAUTH_PREFIX}authorize`:
      return "authorize";
    case `${OAUTH_PREFIX}google-callback`:
      return "callback";
    case `${OAUTH_PREFIX}token`:
      return "token";
    case `${OAUTH_PREFIX}register`:
      return "register";
    default:
      return "metadata";
  }
}

/** Create the remote-MCP router. One per process: it owns the client-file cache, CIMD cache and rate buckets. */
export function createMcpRouter(deps: McpRouterDeps = {}): McpRouter {
  const nowMs = deps.nowMs ?? Date.now;
  const loader = new McpConfigLoader(deps.env ?? process.env, deps.readFile, nowMs);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cimdCache = new CimdCache(nowMs);
  const limiter = new McpRateLimiter(nowMs, deps.rateLimits ?? MCP_RATE_LIMITS);
  const proxyLimits = deps.proxyLimits ?? PROXY_LIMITS;

  return async (req, hooks) => {
    const { pathname } = new URL(req.url);
    if (!isMcpPath(pathname)) return null;
    if (req.method === "OPTIONS") return corsPreflight();

    const taken = limiter.take(rateClass(pathname), hooks.clientAddress);
    if (!taken.ok) {
      return json(
        {
          error: "rate_limited",
          message: `Too many requests from this address. Try again in ${taken.retryAfterSeconds} s.`,
        },
        429,
        { "retry-after": String(taken.retryAfterSeconds) },
      );
    }

    const loaded = await loader.load();

    if (pathname === `${OAUTH_PREFIX}status`) {
      if (req.method !== "GET") return methodNotAllowed("GET");
      // The admin's setup self-check: whether the Owner's client reached
      // this gateway. The client ID is public (every /authorize redirect to
      // Google carries it); the secret never leaves the file.
      if (loaded.ok) {
        return json({ configured: true, clientId: loaded.config.google.clientId });
      }
      if (loaded.notSetUp) return json({ configured: false });
      return notConfiguredResponse(loaded.message);
    }
    if (!loaded.ok) return notConfiguredResponse(loaded.message);

    const ctx: McpContext = {
      config: loaded.config,
      fetchImpl,
      nowSeconds: () => Math.floor(nowMs() / 1000),
      cimdCache,
      proxyLimits,
    };

    const endpoint = MCP_ENDPOINT.exec(pathname);
    if (endpoint) {
      return handleMcpProxy(req, ctx, endpoint[1] as McpSurface, {
        setIdleTimeout: hooks.setIdleTimeout,
      });
    }

    const prSurface = protectedResourceSurface(pathname);
    if (prSurface) {
      return req.method === "GET"
        ? protectedResourceMetadata(ctx.config, prSurface)
        : methodNotAllowed("GET");
    }
    if (AS_METADATA_PATHS.includes(pathname)) {
      return req.method === "GET"
        ? authorizationServerMetadata(ctx.config)
        : methodNotAllowed("GET");
    }
    switch (pathname) {
      case `${OAUTH_PREFIX}authorize`:
        if (req.method === "GET") return handleAuthorize(req, ctx);
        if (req.method === "POST") return handleAuthorizeDecision(req, ctx);
        return methodNotAllowed("GET, POST");
      case `${OAUTH_PREFIX}google-callback`:
        return req.method === "GET" ? handleGoogleCallback(req, ctx) : methodNotAllowed("GET");
      case `${OAUTH_PREFIX}token`:
        return req.method === "POST" ? handleToken(req, ctx) : methodNotAllowed("POST");
      case `${OAUTH_PREFIX}register`:
        return req.method === "POST" ? handleRegister(req, ctx) : methodNotAllowed("POST");
      default:
        return json({ error: "not_found", message: "no such remote-MCP endpoint" }, 404);
    }
  };
}
