// SPDX-License-Identifier: MPL-2.0

/**
 * The MCP-Auth-Proxy (issue #1328): the public service that signs external
 * AI apps (claude.ai, ChatGPT, …) in with the install's Google sign-in client
 * and streams their MCP requests through IAP to the admin. The MCP tools run
 * in the admin; this service holds no database login, no admin credential
 * and no project role — only the Google sign-in client file and the seal
 * key. It used to run inside the visitor gateway, where a hole in any
 * visitor handler would have exposed the operators' Google ID tokens (N1).
 *
 * Each request, in order:
 *
 *   1. `/healthz`, `/api/mcp/health` → `{ ok }` (upgrade health check; no version since #1326).
 *   2. Remote MCP unavailable on this provider ({@link REMOTE_MCP_ENV}), or
 *      a path that is not remote MCP → the fixed 404 (http.ts).
 *   3. The router (routes.ts): the fixed 404 while the Owner has not set up
 *      Google sign-in, else rate limits, the OAuth broker and the proxy.
 *
 * On gcp-firebase this service is the one that served the gateway before
 * #1328 (E13 a). Nothing else reaches it any more since #1331: the live
 * release's `/api/**` rewrite names the data gateway (#1380), and the
 * staging host is served by the staging gateway (#1330) — so it forwards
 * nothing; a visitor request that still arrives gets the fixed 404.
 */

import {
  ClientAddressError,
  clientAddress,
  trustedProxyHopsFromEnv,
  withJsonSecurityHeaders,
} from "@caelo-cms/shared";
import { fixedNotFound } from "./http.js";
import { MAX_PROXY_BODY_BYTES } from "./proxy.js";
import { createMcpRouter, isMcpPath, type McpRouter } from "./routes.js";

/** Whether remote MCP exists on this provider: `available` (Google IAP installs) or `unavailable`. */
export const REMOTE_MCP_ENV = "CAELO_REMOTE_MCP";

export type RemoteMcpMode = "available" | "unavailable";

/** The paths the health check reads; answered on every provider, feature on or off. */
export const HEALTH_PATHS: readonly string[] = ["/healthz", "/api/mcp/health"];

/** Port when the platform sets none (Compose; Cloud Run injects PORT). */
export const DEFAULT_PORT = 8095;

/** Env this service reads at start. */
type Env = Readonly<Record<string, string | undefined>>;

/**
 * {@link REMOTE_MCP_ENV} from `env`.
 *
 * @throws Error when it is unset or not one of the two modes — the
 *   provisioner always sets it, so anything else is a deployment error, and
 *   guessing either way would serve the broker where it cannot work or hide
 *   it where it should.
 */
export function remoteMcpModeFromEnv(env: Env): RemoteMcpMode {
  const raw = env[REMOTE_MCP_ENV];
  if (raw === "available" || raw === "unavailable") return raw;
  throw new Error(
    `${REMOTE_MCP_ENV} is ${raw === undefined ? "not set" : `"${raw}"`}; the MCP-Auth-Proxy needs it to be "available" (Google IAP installs) or "unavailable". Run \`cms-provision upgrade\`, which sets it per provider.`,
  );
}

/** The connection facts a request handler cannot read from the Request itself. */
export interface ProxyConnection {
  /** The TCP peer (Bun `server.requestIP`); read only when no proxy is in front. */
  readonly peerAddress: string | null;
  /**
   * Set Bun's idle timeout for this request (`server.timeout(req, s)`, 0 =
   * none): the proxy waits up to its first-response timeout for the admin,
   * then lifts it for an SSE stream that may stay quiet longer than the 10 s
   * default. Absent outside Bun.serve (tests).
   */
  readonly setIdleTimeout?: (seconds: number) => void;
}

/** What a handler is built from; tests inject env and router. */
export interface ProxyServerDeps {
  readonly env?: Env;
  /** Defaults to {@link createMcpRouter} over `env`. */
  readonly router?: McpRouter;
}

/** A request handler of this service. */
export type ProxyHandler = (req: Request, conn: ProxyConnection) => Promise<Response>;

function health(): Response {
  // #1326 — no release version on a public service: it names the flaws to try.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Build this service's request handler from `deps.env`.
 *
 * @throws Error when {@link REMOTE_MCP_ENV} is invalid — the service
 *   refuses to start instead of guessing.
 */
export function createProxyHandler(deps: ProxyServerDeps = {}): ProxyHandler {
  const env = deps.env ?? process.env;
  const mode = remoteMcpModeFromEnv(env);
  const router = deps.router ?? createMcpRouter({ env });

  // #1326 L2 — every JSON answer (health, the fixed 404, the broker's JSON,
  // the admin's JSON it streams) carries the JSON security headers.
  const own = async (req: Request, conn: ProxyConnection): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (HEALTH_PATHS.includes(pathname)) return health();
    const mcpPath = isMcpPath(pathname);
    if (mode === "unavailable" || !mcpPath) return fixedNotFound();
    try {
      const res = await router(req, {
        clientAddress: () => clientAddress(req, trustedProxyHopsFromEnv(env), conn.peerAddress),
        setIdleTimeout: conn.setIdleTimeout ?? (() => {}),
      });
      return res ?? fixedNotFound();
    } catch (e) {
      if (!(e instanceof ClientAddressError)) throw e;
      // Never a guessed rate-limit bucket: the deployment names the fix.
      console.error(`[mcp-auth-proxy] ${e.message}`);
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: "ClientAddressUnavailable", message: e.message },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    }
  };
  return async (req, conn) => withJsonSecurityHeaders(await own(req, conn));
}

if (import.meta.main) {
  // Refuses to start on an invalid CAELO_REMOTE_MCP.
  const handler = createProxyHandler();
  const mode = remoteMcpModeFromEnv(process.env);
  const port = Number.parseInt(
    process.env.PORT ?? process.env.MCP_AUTH_PROXY_PORT ?? String(DEFAULT_PORT),
    10,
  );
  const server = Bun.serve({
    port,
    // The largest MCP body the proxy forwards (proxy.ts); every OAuth route
    // caps lower while it reads. Bun's default would buffer 128 MB first.
    maxRequestBodySize: MAX_PROXY_BODY_BYTES,
    fetch: (req, srv) =>
      handler(req, {
        peerAddress: srv.requestIP(req)?.address ?? null,
        setIdleTimeout: (seconds) => srv.timeout(req, seconds),
      }),
  });
  console.log(`[mcp-auth-proxy] listening on :${server.port} (remote MCP ${mode})`);
}
