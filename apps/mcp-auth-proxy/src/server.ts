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
 *   1. `/healthz`, `/api/mcp/health` → `{ ok, version }` (upgrade health check).
 *   2. FIXME(issue #1331) — the interim forwarder ({@link INTERIM_FORWARD_ORIGIN_ENV},
 *      gcp-firebase only): every request that is not remote MCP on this
 *      service's own host is streamed unchanged to the visitor data gateway.
 *   3. Remote MCP unavailable on this provider ({@link REMOTE_MCP_ENV}), or
 *      a path that is not remote MCP → the fixed 404 (http.ts).
 *   4. The router (routes.ts): the fixed 404 while the Owner has not set up
 *      Google sign-in, else rate limits, the OAuth broker and the proxy.
 *
 * Why the forwarder exists: on gcp-firebase the Cloud Run service that
 * served the gateway became this service, so the MCP URL the connectors in
 * claude.ai / ChatGPT hold and the redirect URI registered with Google stay
 * the same (E13 a). Two things still point at that service after the
 * upgrade: the Firebase Hosting `/api/**` rewrite of the release that is
 * live (the next Publish live re-points it to the data gateway) and an
 * existing staging domain mapping (#650; only a verified domain owner can
 * move it, P3b-2 replaces it). Both reach the visitor gateway through here
 * until then; the forwarder never reads a body and never sees MCP traffic.
 */

import {
  CAELO_VERSION,
  ClientAddressError,
  clientAddress,
  INTERIM_FORWARDED_HOST_HEADER,
  trustedProxyHopsFromEnv,
  withJsonSecurityHeaders,
} from "@caelo-cms/shared";
import { fixedNotFound } from "./http.js";
import { createMcpRouter, isMcpPath, type McpRouter } from "./routes.js";

/** Whether remote MCP exists on this provider: `available` (Google IAP installs) or `unavailable`. */
export const REMOTE_MCP_ENV = "CAELO_REMOTE_MCP";

export type RemoteMcpMode = "available" | "unavailable";

/**
 * FIXME(issue #1331): origin of the visitor data gateway the interim
 * forwarder streams non-MCP requests to. Set on gcp-firebase only.
 */
export const INTERIM_FORWARD_ORIGIN_ENV = "CAELO_INTERIM_FORWARD_ORIGIN";

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

/**
 * {@link INTERIM_FORWARD_ORIGIN_ENV} from `env`: null when unset.
 *
 * @throws Error when it is set but not a bare https origin (http only on
 *   loopback, for local runs).
 */
export function interimForwardOriginFromEnv(env: Env): string | null {
  const raw = env[INTERIM_FORWARD_ORIGIN_ENV];
  if (raw === undefined || raw === "") return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const loopback = url !== null && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url === null ||
    raw !== url.origin ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      `${INTERIM_FORWARD_ORIGIN_ENV}="${raw}" is not a bare https:// origin (no path, no trailing slash). Run \`cms-provision upgrade\`, which sets it to the data gateway's URL.`,
    );
  }
  return url.origin;
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

/** What a handler is built from; tests inject env, router and upstream fetch. */
export interface ProxyServerDeps {
  readonly env?: Env;
  /** Defaults to {@link createMcpRouter} over `env`. */
  readonly router?: McpRouter;
  /** The interim forwarder's upstream fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** A request handler of this service. */
export type ProxyHandler = (req: Request, conn: ProxyConnection) => Promise<Response>;

/** Headers a hop must not pass on (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The host `req` was addressed to, lowercased. */
function requestHost(req: Request): string {
  return (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
}

/**
 * The headers the interim forwarder sends upstream: everything the client
 * sent except hop-by-hop headers, Host (Cloud Run routes by it),
 * `forwarded` / `x-forwarded-*` (the gateway trusts only what its own
 * front end appends) and `x-caelo-*` (Caelo's own plumbing, never the
 * client's), plus the original host under
 * {@link INTERIM_FORWARDED_HOST_HEADER}.
 */
export function interimForwardHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "host" || n === "content-length" || n === "forwarded") continue;
    if (n.startsWith("x-forwarded-") || n.startsWith("x-caelo-")) continue;
    headers.append(name, value);
  }
  headers.set(INTERIM_FORWARDED_HOST_HEADER, requestHost(req));
  return headers;
}

/** Stream `req` to `origin` unchanged and its answer back (see the module comment). */
async function interimForward(
  req: Request,
  origin: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${origin}${url.pathname}${url.search}`, {
      method: req.method,
      headers: interimForwardHeaders(req),
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
      // The gateway's encoded bytes pass through untouched.
      decompress: false,
    } as RequestInit);
  } catch (e) {
    console.error(
      `[mcp-auth-proxy] data gateway unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return new Response('{"error":"bad_gateway"}', {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === "set-cookie") continue;
    headers.append(name, value);
  }
  // Headers iteration folds Set-Cookie; each cookie must stay its own header.
  for (const c of upstream.headers.getSetCookie()) headers.append("set-cookie", c);
  return new Response(req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function health(): Response {
  return new Response(JSON.stringify({ ok: true, version: CAELO_VERSION }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Build this service's request handler from `deps.env`.
 *
 * @throws Error when {@link REMOTE_MCP_ENV} or {@link INTERIM_FORWARD_ORIGIN_ENV}
 *   is invalid — the service refuses to start instead of guessing.
 */
export function createProxyHandler(deps: ProxyServerDeps = {}): ProxyHandler {
  const env = deps.env ?? process.env;
  const mode = remoteMcpModeFromEnv(env);
  const forwardOrigin = interimForwardOriginFromEnv(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const router = deps.router ?? createMcpRouter({ env });
  let ownHost: string | null = null;
  try {
    ownHost = env.CAELO_MCP_PUBLIC_URL ? new URL(env.CAELO_MCP_PUBLIC_URL).host : null;
  } catch {
    // A malformed public URL is the router's to report (config.ts names it);
    // the forwarder then treats no host as its own.
    ownHost = null;
  }

  // #1326 L2 — every JSON answer of the proxy's own (health, the fixed 404,
  // the broker's JSON, the admin's JSON it streams) carries the JSON
  // security headers. Interim-forwarded answers are the data gateway's,
  // which sets its own, and pass unchanged.
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
  return async (req, conn) => {
    const { pathname } = new URL(req.url);
    if (
      forwardOrigin &&
      !HEALTH_PATHS.includes(pathname) &&
      !(isMcpPath(pathname) && ownHost !== null && requestHost(req) === ownHost)
    ) {
      // Bun cuts a socket idle for 10 s; a scale-to-zero data gateway's cold
      // start can take longer than that to answer. 60 s is what the
      // Firebase rewrite in front of the /api/** share allows anyway.
      conn.setIdleTimeout?.(60);
      return interimForward(req, forwardOrigin, fetchImpl);
    }
    return withJsonSecurityHeaders(await own(req, conn));
  };
}

if (import.meta.main) {
  // Refuses to start on an invalid CAELO_REMOTE_MCP / forward origin.
  const handler = createProxyHandler();
  const mode = remoteMcpModeFromEnv(process.env);
  const port = Number.parseInt(
    process.env.PORT ?? process.env.MCP_AUTH_PROXY_PORT ?? String(DEFAULT_PORT),
    10,
  );
  const server = Bun.serve({
    port,
    fetch: (req, srv) =>
      handler(req, {
        peerAddress: srv.requestIP(req)?.address ?? null,
        setIdleTimeout: (seconds) => srv.timeout(req, seconds),
      }),
  });
  console.log(
    `[mcp-auth-proxy] listening on :${server.port} (remote MCP ${mode}${interimForwardOriginFromEnv(process.env) ? ", interim forwarder on" : ""})`,
  );
}
