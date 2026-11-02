// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo API gateway — public-facing HTTP entry point for plugin operations.
 *
 * Routes:
 *   POST /api/plugin/<slug>/<operation>     JSON body → JSON response
 *   GET  /api/captcha/challenge             PoW challenge envelope
 *   GET  /healthz                           liveness probe
 *   GET  /api/_caelo/health[?deep=1]        upgrade health check (health.ts)
 *   *    /api/mcp/*, /.well-known/oauth-*    #806 remote MCP: OAuth broker +
 *                                           streaming proxy to the IAP-protected
 *                                           admin (mcp/routes.ts); no database
 *   *    (Host: staging.<domain>)           #650 staging gate + proxy to the
 *                                           staged build (staging-proxy.ts)
 *
 * Before anything reaches the database (#1326 — the cheap setup has no WAF
 * in front, E3, so the gateway must shed junk itself): a path that names no
 * route is a 404; every visitor route takes a token from the per-client
 * in-memory limiter (memory-limiter.ts); a plugin POST must be JSON from a
 * live-site Origin (plugin-request-filter.ts) and name an operation an
 * active plugin serves to visitors, or it gets a 404 that writes nothing.
 * Every error a visitor sees is `{ kind, requestId }`; the details go to
 * the log under that request id, never into the answer.
 *
 * Each public-write request flows through (in order):
 *   1. Body-size cap (default 64 KB; 1 MB hard ceiling).
 *   2. Resolve signed visitor cookie + signed session cookie (HMAC-SHA256).
 *      The visitor id exists only when an active plugin declares the
 *      `visitor_id` consent purpose and the visitor granted its category
 *      (#677, visitor.ts): otherwise no id, no Set-Cookie, and any id the
 *      browser still holds is expired. Tampered → a fresh id (consented).
 *   3. Honeypot edge-evict — bot-filled `hp_address` returns {ok:true}
 *      immediately, no DB writes, no audit, only an IP-scoped rate-limit
 *      token.
 *   4. Per-(plugin, op, client address) rate limit + token-bucket burst
 *      gate. Never keyed by the visitor cookie: a client sheds a cookie
 *      at will, so a cookie-keyed budget is no limit. 429 with
 *      Retry-After when exceeded.
 *   5. Captcha verify (when configured + plugin op opts in via
 *      `_caelo_captcha`). PoW provider in v1; Turnstile/hCaptcha later.
 *   6. Plugin host dispatch + sessionMutation cookie emission.
 *   7. Request log row written async (best-effort; failure does not
 *      affect the response).
 *
 * Database identity (issues #613, #635; CLAUDE.md §2): the gateway has NO
 * cms_admin login. It connects to cms_public only, as `public_role`:
 *
 *   - its own state lives there (rate-limit buckets, captcha challenges,
 *     request log, plugin op events — cms_public migration 0280), and it
 *     garbage-collects it itself;
 *   - what it needs from authoring state (its settings, the staging gate,
 *     rate-limit overrides, the active-plugin registry, each plugin's
 *     declared `visitorProjection`, approved comments) the admin PUBLISHES
 *     into cms_public (`@caelo-cms/migrations/public-projection`), one way,
 *     and NOTIFYs `caelo_gateway_settings` there.
 *
 * Its plugin host only attaches what the admin published as active
 * (plugin-host gateway-attach.ts); it never registers, provisions or
 * activates anything itself. Its OperationRegistry holds only the core
 * operations visitor paths call, all on cms_public (plugin-host
 * gateway-ops.ts).
 */

import { resolve } from "node:path";
import {
  bootstrapDispatchOnly,
  ensureDevSignedManifests,
  loadedPlugins,
  pluginDeclaresConsentPurpose,
  registerGatewayOperations,
  runPluginOperation,
  syncDispatchPlugins,
  unpublishedRegistryError,
  VISITOR_ID_PURPOSE,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, OperationRegistry, type TransactionRunner } from "@caelo-cms/query-api";
import { STAGING_PLUGIN_STUB_BODY } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  ClientAddressError,
  clientAddress,
  hashClientAddress,
  rateLimitAddress,
  trustedProxyHopsFromEnv,
} from "./client-ip.js";
import {
  databaseIsolationProblems,
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
} from "./database-env.js";
import { gatewayStateGc } from "./gc.js";
import { GATEWAY_HEALTH_PATH, gatewayHealth } from "./health.js";
import { type IpHashKeys, ipHashKeys } from "./ip-hash-key.js";
import { MAX_PROXY_BODY_BYTES } from "./mcp/proxy.js";
import { createMcpRouter, isMcpPath } from "./mcp/routes.js";
import { HARD_MAX_BODY_BYTES, readBodyWithCap } from "./middleware/body-cap.js";
import { type CaptchaConfig, issuePowChallenge, verifyPowProof } from "./middleware/captcha.js";
import { checkHoneypot } from "./middleware/honeypot.js";
import {
  MemoryRateLimiter,
  OPERATION_MEMORY_LIMIT,
  VISITOR_MEMORY_LIMIT,
} from "./middleware/memory-limiter.js";
import { parsePluginPath, refusePluginRequest } from "./middleware/plugin-request-filter.js";
import {
  consumeRateLimit,
  invalidateRateLimitSpecCache,
  ipScopedRateLimitKey,
  resolveRateLimitSpec,
} from "./middleware/rate-limit.js";
import { addJsonSecurityHeaders, withJsonSecurityHeaders } from "./middleware/security-headers.js";
import { signCookieValue } from "./middleware/signed-cookie.js";
import {
  listenForPublishedChanges,
  mayCacheRead,
  onPublishedChange,
  publishedCacheGeneration,
  publishedCacheUsable,
} from "./published-changes.js";
import {
  handleStagingRequest,
  isStagingRequest,
  type StagingState,
  stagingGateFromEnv,
} from "./staging-proxy.js";
import {
  ANONYMOUS_VISITOR_ACTOR,
  invalidateVisitorConsentRule,
  loadVisitorConsentRule,
  type ResolvedVisitor,
  resolveVisitor,
  SESSION_COOKIE,
  visitorIdDeclared,
} from "./visitor.js";

export {
  GATEWAY_DATABASE_ENV,
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
} from "./database-env.js";
export { parseCookies, VISITOR_COOKIE } from "./visitor.js";

const SYSTEM_ACTOR_ID = process.env.CAELO_SYSTEM_ACTOR_ID ?? "00000000-0000-0000-0000-00000000ffff";
// Cloud Run sets PORT=8080 on every container; read that first so a
// platform deploy needs no extra config. GATEWAY_PORT is the historical
// name retained for self-hosted Compose installs.
const PORT = Number.parseInt(process.env.PORT ?? process.env.GATEWAY_PORT ?? "8090", 10);
const PLUGINS_ROOT = resolve(import.meta.dir, "../../../packages/plugins");

const SYSTEM_CTX = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "gateway",
};

// ---------------------------------------------------------------------------
// Cookie helpers (signed via HMAC-SHA256).
// ---------------------------------------------------------------------------

export function sessionCookieHeader(args: { value: string; maxAge: number }): string {
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(args.value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${args.maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}

export function clearSessionCookieHeader(): string {
  const flags = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}

// ---------------------------------------------------------------------------
// Settings cache — gateway secret + body cap + captcha provider, as the
// admin publishes them from `site_settings` (published_gateway_settings).
// ---------------------------------------------------------------------------

interface GatewaySettings {
  cookieSecret: string;
  maxBodyBytes: number;
  captcha: CaptchaConfig;
  /**
   * #1326 — the live site's origins, the only ones plugin posts are taken
   * from; null when the admin that published the row predates the column.
   */
  liveOrigins: readonly string[] | null;
}

// Cached while the LISTEN on the admin's publish notifications is
// acknowledged, dropped on every notification (#1267, published-changes.ts):
// a cookie-secret rotation takes effect on the next request, on every
// replica, with no TTL to wait out.
let cachedSettings: GatewaySettings | null = null;

async function loadSettings(adapter: DatabaseAdapter): Promise<GatewaySettings> {
  if (cachedSettings && publishedCacheUsable()) return cachedSettings;
  const startedAt = publishedCacheGeneration();
  const { published, rows } = await adapter.withPublicTransaction(SYSTEM_CTX, async (tx) => ({
    published: await sectionPublished(tx, "settings"),
    rows: (await tx.execute(sql`
      SELECT cookie_secret, max_body_bytes, captcha_provider, captcha_pow_target_prefix,
             live_origins
      FROM published_gateway_settings WHERE id = 1
    `)) as unknown as {
      cookie_secret: string | null;
      max_body_bytes: number;
      captcha_provider: "off" | "pow" | "turnstile" | "hcaptcha";
      captcha_pow_target_prefix: string;
      live_origins: string[] | null;
    }[],
  }));
  const row = rows[0];
  const secret = row?.cookie_secret;
  if (!row || !secret) {
    // The admin publishes these (#635); the gateway can neither read
    // site_settings nor mint a secret of its own.
    throw new GatewayNotReadyError(
      published
        ? "the admin published no gateway cookie secret; run the database migrations (0248 seeds it) or rotate it from /settings/gateway"
        : "the admin has not published the gateway settings yet; run the database migrations (they publish them) or start the admin",
    );
  }
  const settings: GatewaySettings = {
    cookieSecret: secret,
    maxBodyBytes: row?.max_body_bytes ?? 65536,
    captcha: {
      provider: row?.captcha_provider ?? "pow",
      powTargetPrefix: row?.captcha_pow_target_prefix ?? "000fff",
    },
    liveOrigins: row.live_origins,
  };
  if (mayCacheRead(startedAt)) cachedSettings = settings;
  return settings;
}

/** The gateway cannot serve yet; answered as 503 with the reason. */
export class GatewayNotReadyError extends Error {
  override readonly name = "GatewayNotReadyError";
}

/**
 * The 503 for settings that could not be loaded. The visitor learns the
 * kind and the request id, nothing else (#1326): an unreachable database, a
 * refused login or a broken query would hand an unauthenticated visitor
 * hosts, role names or SQL, and even the gateway's own readiness reason
 * ({@link GatewayNotReadyError}) is for the operator. Both are logged under
 * the request id.
 */
export function settingsUnavailable(e: unknown, requestId: string): Response {
  return errorResponse("ServiceUnavailable", 503, requestId, {
    log:
      e instanceof GatewayNotReadyError
        ? `gateway not ready: ${e.message}`
        : `gateway settings could not be loaded: ${describeFailure(e)}`,
  });
}

/**
 * A failure for the server log: its class, SQLSTATE and message, with the
 * credentials a connection URL in the message could carry masked.
 */
function describeFailure(e: unknown): string {
  if (!(e instanceof Error)) return "non-Error thrown";
  const code = (e as { code?: unknown }).code;
  // Bounded quantifiers: an unbounded `\w+` before `://` backtracks
  // quadratically on a long message without one (CodeQL js/polynomial-redos).
  const message = e.message.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s@/]{0,512}@/gi, "$1***@");
  return `${e.name}${typeof code === "string" ? ` (${code})` : ""}: ${message}`;
}

/** Whether the admin has published `section` into cms_public (#635). */
async function sectionPublished(tx: TransactionRunner, section: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT 1 AS ok FROM published_projection_sections WHERE section = ${section}`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

export function invalidateGatewaySettings(): void {
  cachedSettings = null;
  cachedStagingState = null;
  invalidateVisitorConsentRule();
}

// ---------------------------------------------------------------------------
// Staging gate state (#650) — the staging_access row: access modes and the
// current staged build's origin. Cached and invalidated like the settings
// above (the admin notifies on every change and every Stage).
// ---------------------------------------------------------------------------

let cachedStagingState: StagingState | null = null;

async function loadStagingState(adapter: DatabaseAdapter): Promise<StagingState> {
  if (cachedStagingState && publishedCacheUsable()) return cachedStagingState;
  const startedAt = publishedCacheGeneration();
  const rows = (await adapter.withPublicTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`
        SELECT staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce,
               header_enabled, header_name, header_nonce, ip_allowlist, origin_url
        FROM published_staging_access WHERE id = 1
      `),
  )) as unknown as {
    staging_host: string | null;
    cookie_enabled: boolean;
    basic_auth_enabled: boolean;
    basic_auth_user: string;
    basic_auth_nonce: string | null;
    header_enabled: boolean;
    header_name: string;
    header_nonce: string | null;
    ip_allowlist: string[] | string;
    origin_url: string | null;
  }[];
  const row = rows[0];
  if (!row) {
    throw new GatewayNotReadyError(
      "the admin has not published the staging gate settings yet; run the database migrations (they publish them) or start the admin",
    );
  }
  const state: StagingState = {
    host: row.staging_host,
    settings: {
      cookieEnabled: row.cookie_enabled,
      basicAuthEnabled: row.basic_auth_enabled,
      basicAuthUser: row.basic_auth_user,
      basicAuthNonce: row.basic_auth_nonce,
      headerEnabled: row.header_enabled,
      headerName: row.header_name,
      headerNonce: row.header_nonce,
      ipAllowlist:
        typeof row.ip_allowlist === "string"
          ? (JSON.parse(row.ip_allowlist) as string[])
          : row.ip_allowlist,
    },
    originUrl: row.origin_url,
  };
  if (mayCacheRead(startedAt)) cachedStagingState = state;
  return state;
}

// ---------------------------------------------------------------------------
// Visitor resolution under the visitor's consent (#677, visitor.ts).
// ---------------------------------------------------------------------------

/**
 * Resolve the visitor, or answer 503 when the site's consent provider runs
 * but cannot say what the visitor decided. Guessing either way is wrong:
 * "yes" would set a cookie nobody agreed to, and quietly treating a broken
 * provider as "no" would hide that the banner itself is broken.
 */
async function resolveConsentedVisitor(
  req: Request,
  settings: GatewaySettings,
  requestId: string,
): Promise<{ ok: true; visitor: ResolvedVisitor } | { ok: false; response: Response }> {
  try {
    // The registry sync first, so a consent provider an Owner just
    // activated (or disabled) is the one asked.
    await syncDispatchPlugins();
    const rule = await loadVisitorConsentRule();
    const visitor = await resolveVisitor({
      req,
      secret: settings.cookieSecret,
      rule,
      visitorIdDeclared: visitorIdDeclared(),
      sign: (value) => signCookieValue({ value, secret: settings.cookieSecret }),
    });
    return { ok: true, visitor };
  } catch (e) {
    return {
      ok: false,
      response: errorResponse("ConsentUnavailable", 503, requestId, {
        log: `visitor consent could not be resolved: ${describeFailure(e)}`,
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Request log — best-effort append.
// ---------------------------------------------------------------------------

interface RequestLogRow {
  pluginSlug: string;
  operation: string;
  statusCode: number;
  durationMs: number;
  bodyBytes: number;
  wasRateLimited: boolean;
  wasHoneypotCaught: boolean;
  captchaPassed: boolean;
  errorKind?: string | null;
}

let cachedAdapter: DatabaseAdapter | null = null;
/** The gateway's own state, expired rows only (#763 L4: never waits on the admin). */
let sweepGatewayStateIfDue: (() => Promise<void>) | null = null;
/** #1338 — the rotating key of the client-address hashes (ip-hash-key.ts). */
let addressHashKeys: IpHashKeys | null = null;
export function setGatewayAdapter(adapter: DatabaseAdapter): void {
  cachedAdapter = adapter;
  sweepGatewayStateIfDue = gatewayStateGc(adapter);
  addressHashKeys = ipHashKeys(adapter);
}

/**
 * Awaited by every caller before it answers: the gateway gets CPU only while
 * a request runs (request-based Cloud Run CPU), so a write left running
 * after the response would stall until the next request, or be lost when
 * the instance stops first.
 */
async function recordRequest(row: RequestLogRow): Promise<void> {
  if (!cachedAdapter) return;
  try {
    await cachedAdapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
      await tx.execute(sql`
        INSERT INTO gateway_request_log (
          plugin_slug, operation, status_code, duration_ms,
          body_bytes, was_rate_limited, was_honeypot_caught, captcha_passed, error_kind
        ) VALUES (
          ${row.pluginSlug}, ${row.operation}, ${row.statusCode},
          ${row.durationMs}, ${row.bodyBytes}, ${row.wasRateLimited},
          ${row.wasHoneypotCaught}, ${row.captchaPassed}, ${row.errorKind ?? null}
        )
      `);
    });
  } catch {
    // Best-effort: never let log failure affect the response.
  }
}

// ---------------------------------------------------------------------------
// JSON response helper.
// ---------------------------------------------------------------------------

/**
 * Captcha challenges one client address may mint. A real
 * visitor needs one per form submission; the cap bounds the rows a flood
 * can insert into gateway_pow_challenges before the hourly GC.
 */
export const CAPTCHA_CHALLENGE_RATE_LIMIT = { perVisitorMax: 60, windowSeconds: 60 } as const;

/**
 * The largest request body Bun accepts at all (#1326): the visitor routes'
 * hard ceiling, or the remote-MCP proxy's (image uploads), whichever is
 * larger. Each route still enforces its own, smaller cap while it reads;
 * this one stops a body nobody would read before it is buffered (Bun's
 * default is 128 MB).
 */
export const SERVER_MAX_REQUEST_BODY_BYTES = Math.max(HARD_MAX_BODY_BYTES, MAX_PROXY_BODY_BYTES);

/** Every visitor route's in-memory budget per client, before the database (#1326). */
const visitorMemoryLimiter = new MemoryRateLimiter(VISITOR_MEMORY_LIMIT);

/**
 * Every visitor route's in-memory budget per operation, whoever calls it
 * (#1326; the binding guard on gcp-firebase, where no client address is
 * stable — memory-limiter.ts OPERATION_MEMORY_LIMIT).
 */
const operationMemoryLimiter = new MemoryRateLimiter(OPERATION_MEMORY_LIMIT, 10_000);

/** Take one token of `operation`'s budget: the 429, or null to go on. */
function operationRateLimited(operation: string, requestId: string): Response | null {
  const take = operationMemoryLimiter.take(operation);
  if (take.allowed) return null;
  return errorResponse("RateLimited", 429, requestId, {
    retryAfterSec: take.retryAfterSec,
    log: `site-wide budget of ${operation} spent on this instance`,
  });
}

function jsonResponse(
  body: unknown,
  init: {
    status?: number;
    setCookies?: string[];
    retryAfterSec?: number;
    requestId?: string;
  } = {},
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  addJsonSecurityHeaders(headers);
  for (const c of init.setCookies ?? []) headers.append("Set-Cookie", c);
  if (init.retryAfterSec !== undefined) {
    headers.set("Retry-After", String(init.retryAfterSec));
  }
  if (init.requestId) headers.set("X-Request-Id", init.requestId);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * The only shape of error a visitor sees (#1326): `{ ok: false, error: {
 * kind, requestId } }`. No message: what went wrong in detail — an
 * exception's text, a plugin's, a limit's numbers — goes to the log under
 * the same request id (`log`), so an operator can find it from a visitor's
 * report and the visitor learns nothing about the inside.
 */
function errorResponse(
  kind: string,
  status: number,
  requestId: string,
  init: { setCookies?: string[]; retryAfterSec?: number; log?: string } = {},
): Response {
  if (init.log) console.error(`[api-gateway] request ${requestId}: ${kind} — ${init.log}`);
  return jsonResponse(
    { ok: false, error: { kind, requestId } },
    {
      status,
      requestId,
      ...(init.setCookies ? { setCookies: init.setCookies } : {}),
      ...(init.retryAfterSec !== undefined ? { retryAfterSec: init.retryAfterSec } : {}),
    },
  );
}

/** The connection facts `handleRequest` cannot read from the Request itself. */
export interface GatewayConnection {
  /** The TCP peer (Bun `server.requestIP`); read only when no proxy is in front. */
  readonly peerAddress: string | null;
  /**
   * Set Bun's idle timeout for this request (`server.timeout(req, s)`, 0 =
   * none): the remote-MCP proxy waits up to its first-response timeout for
   * the admin, then lifts it for an SSE stream that may stay quiet longer
   * than the 10 s default. Absent outside Bun.serve (tests), where there is
   * no timeout to change.
   */
  readonly setIdleTimeout?: (seconds: number) => void;
}

/**
 * #806 remote MCP. Created once: it caches the OAuth client file. It reads
 * env + that file only — no database, so it answers before (and without)
 * the gateway's settings.
 */
const mcpRouter = createMcpRouter();

type Resolved<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

/**
 * Run a client-address lookup (client-ip.ts), answering a deployment that
 * cannot name the visitor with a 503 that says why instead of a guess.
 */
function resolveClientAddress<T>(lookup: () => T, requestId: string): Resolved<T> {
  try {
    return { ok: true, value: lookup() };
  } catch (e) {
    if (!(e instanceof ClientAddressError)) throw e;
    return {
      ok: false,
      response: errorResponse("ClientAddressUnavailable", 503, requestId, { log: e.message }),
    };
  }
}

/** `req`'s client address under the deployment's proxy hops (client-ip.ts). */
function requestClientAddress(
  req: Request,
  conn: GatewayConnection,
  requestId: string,
): Resolved<string> {
  return resolveClientAddress(
    () => clientAddress(req, trustedProxyHopsFromEnv(process.env), conn.peerAddress),
    requestId,
  );
}

/** The rate-limit bucket hash of a client address, under today's key (#1338). */
async function clientIpHash(address: string): Promise<string> {
  if (!addressHashKeys) throw new Error("gateway not bootstrapped (no IP-hash key store)");
  return hashClientAddress(address, await addressHashKeys.current());
}

/**
 * Take one token of the client's in-memory budget (#1326): the 429 before
 * any database access, or null when the request may go on.
 */
function memoryRateLimited(address: string, requestId: string): Response | null {
  const take = visitorMemoryLimiter.take(rateLimitAddress(address));
  if (take.allowed) return null;
  return errorResponse("RateLimited", 429, requestId, { retryAfterSec: take.retryAfterSec });
}

// ---------------------------------------------------------------------------
// Main handler.
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: Request,
  conn: GatewayConnection = { peerAddress: null },
): Promise<Response> {
  // Every JSON answer carries the security headers (#1326), also the ones
  // the staging proxy and the remote-MCP router build themselves.
  const requestId = crypto.randomUUID();
  try {
    return withJsonSecurityHeaders(await routeRequest(req, conn, requestId));
  } catch (e) {
    // The last boundary: a database failure in the rate limit, the captcha
    // or the request pipeline is still answered in the visitor error shape,
    // with the details in the log under the request id — never as Bun's
    // generic 500 or the exception's text.
    return errorResponse("ServiceUnavailable", 503, requestId, {
      log: `unhandled: ${describeFailure(e)}`,
    });
  }
}

async function routeRequest(
  req: Request,
  conn: GatewayConnection,
  requestId: string,
): Promise<Response> {
  const url = new URL(req.url);

  // #650 — the staging host (gcp-firebase; the stored setting, default
  // staging.<domain>): the access gate + proxy to the staged build. Nothing
  // below (plugin dispatch, captcha) serves it.
  const stagingGate = stagingGateFromEnv(process.env);
  if (
    stagingGate &&
    cachedAdapter &&
    url.pathname !== "/healthz" &&
    url.pathname !== GATEWAY_HEALTH_PATH
  ) {
    let state: StagingState | null = null;
    try {
      state = await loadStagingState(cachedAdapter);
    } catch (e) {
      // Not knowing the staging host must not take /api/* down with it; the
      // routes below answer from their own settings (or 503 on their own).
      console.error(`[api-gateway] staging host unavailable: ${describeFailure(e)}`);
    }
    if (state?.host && isStagingRequest(req, state.host)) {
      const loaded = state;
      // The allowlist matches the same address the rate limits bucket by.
      const clientIp = requestClientAddress(req, conn, requestId);
      if (!clientIp.ok) return clientIp.response;
      return handleStagingRequest(req, {
        config: { stagingOrigin: `https://${loaded.host}`, secret: stagingGate.secret },
        clientIp: clientIp.value,
        loadState: async () => loaded,
      });
    }
  }

  if (url.pathname === "/healthz") {
    return jsonResponse({ ok: true });
  }
  if (req.method === "GET" && url.pathname === GATEWAY_HEALTH_PATH) {
    // The deep check is throttled per client (health.ts); liveness needs no address.
    let client: string | null = null;
    if (url.searchParams.get("deep") === "1") {
      const address = requestClientAddress(req, conn, requestId);
      if (!address.ok) return address.response;
      client = rateLimitAddress(address.value);
    }
    return gatewayHealth(url, cachedAdapter, { client, requestId });
  }

  // #806 — before the database-backed pipeline: remote MCP needs neither
  // the gateway's settings nor its plugin host.
  // Rate limited per client address inside the router (mcp/rate-limit.ts),
  // so the address is resolved by the same rule as every other limit here.
  // Its OAuth routes post forms without `Origin`, so the plugin routes'
  // Origin rule below never applies to them.
  if (isMcpPath(url.pathname)) {
    const mcpClient = requestClientAddress(req, conn, requestId);
    if (!mcpClient.ok) return mcpClient.response;
    const mcp = await mcpRouter(req, {
      clientAddress: mcpClient.value,
      setIdleTimeout: conn.setIdleTimeout ?? (() => {}),
    });
    if (mcp) return mcp;
  }

  // ---- #1326: the input filter, before any database access ----
  const isCaptchaChallenge = req.method === "GET" && url.pathname === "/api/captcha/challenge";
  const pluginRoute = req.method === "POST" ? parsePluginPath(url.pathname) : null;
  if (!isCaptchaChallenge && !pluginRoute) {
    return errorResponse("NotFound", 404, requestId);
  }
  const client = requestClientAddress(req, conn, requestId);
  if (!client.ok) return client.response;
  const memoryLimited = memoryRateLimited(client.value, requestId);
  if (memoryLimited) return memoryLimited;

  if (!cachedAdapter) {
    return errorResponse("ServiceUnavailable", 503, requestId, { log: "gateway not bootstrapped" });
  }
  const adapter = cachedAdapter;
  let settings: GatewaySettings;
  try {
    settings = await loadSettings(adapter);
  } catch (e) {
    return settingsUnavailable(e, requestId);
  }

  if (isCaptchaChallenge) return captchaChallenge(req, settings, client.value, requestId);
  if (!pluginRoute) return errorResponse("NotFound", 404, requestId);
  return pluginOperation(req, settings, client.value, pluginRoute, requestId);
}

/** `GET /api/captcha/challenge`: a PoW challenge, bounded per client address. */
async function captchaChallenge(
  req: Request,
  settings: GatewaySettings,
  clientIp: string,
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  if (settings.captcha.provider === "off") {
    return new Response(null, { status: 204 });
  }
  if (settings.captcha.provider !== "pow") {
    return errorResponse("NotImplemented", 501, requestId, {
      log: `captcha provider ${settings.captcha.provider} is not wired yet`,
    });
  }
  const opLimited = operationRateLimited("_captcha.challenge", requestId);
  if (opLimited) return opLimited;
  await sweepGatewayStateIfDue?.();
  const resolved = await resolveConsentedVisitor(req, settings, requestId);
  if (!resolved.ok) return resolved.response;
  const { visitor } = resolved;
  // Each challenge is a row in gateway_pow_challenges: bound the minting
  // per client address (client-ip.ts).
  const challengeRl = await consumeRateLimit(adapter, {
    key: ipScopedRateLimitKey("_captcha", "challenge", await clientIpHash(clientIp)),
    spec: CAPTCHA_CHALLENGE_RATE_LIMIT,
  });
  if (!challengeRl.allowed) {
    return errorResponse("RateLimited", 429, requestId, {
      setCookies: [...visitor.setCookies],
      retryAfterSec: challengeRl.retryAfterSec,
    });
  }
  const challenge = await issuePowChallenge(adapter, { config: settings.captcha });
  return jsonResponse({ ok: true, data: challenge }, { setCookies: [...visitor.setCookies] });
}

/**
 * Whether the active plugin `slug` serves `operation` to visitors, from
 * the registry the admin published (synced at most every few seconds, no
 * write): the 404 for an invented name comes before the body is read, a
 * rate-limit bucket exists or a log row is written (#1326 M1). The
 * dispatcher keeps its own default-deny check; this one only keeps junk
 * out of the database.
 */
async function servedToVisitors(
  slug: string,
  operation: string,
): Promise<"served" | "unknown" | "unpublished"> {
  await syncDispatchPlugins();
  const plugin = loadedPlugins.bySlug(slug);
  if (!plugin) return unpublishedRegistryError() ? "unpublished" : "unknown";
  const served =
    Object.hasOwn(plugin.definition.operations, operation) &&
    (plugin.definition.publicOperations ?? []).includes(operation);
  return served ? "served" : "unknown";
}

/**
 * Whether `req` comes from the staging host's pages (`Origin` is
 * `https://<staging host>`, as the admin published it). False when no
 * staging host is set or the gate state cannot be read: the caller then
 * refuses the request like any other foreign origin.
 */
async function isStagingOrigin(req: Request, adapter: DatabaseAdapter): Promise<boolean> {
  const origin = req.headers.get("origin")?.toLowerCase();
  if (!origin) return false;
  try {
    const state = await loadStagingState(adapter);
    return state.host !== null && origin === `https://${state.host.toLowerCase()}`;
  } catch (e) {
    console.error(`[api-gateway] staging host unavailable: ${describeFailure(e)}`);
    return false;
  }
}

/** `POST /api/plugin/<slug>/<operation>` (pipeline in the file comment). */
async function pluginOperation(
  req: Request,
  settings: GatewaySettings,
  clientIp: string,
  route: { readonly slug: string; readonly operation: string },
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  const { slug, operation: operationName } = route;
  if (settings.liveOrigins === null || settings.liveOrigins.length === 0) {
    return errorResponse("ServiceUnavailable", 503, requestId, {
      log:
        settings.liveOrigins === null
          ? "the admin has not published the live site origins yet (published_gateway_settings.live_origins); run the database migrations (they publish them) or start the admin"
          : "no live site origin is known, so no plugin request can be accepted; set the site's base URL (site_defaults.site_base_url, Settings → SEO) or add a public domain (Settings → Domains)",
    });
  }
  // A browser marks a POST another site's page triggers as cross-site.
  // Defense in depth below the Origin rule, which also refuses staging.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return errorResponse("Forbidden", 403, requestId);
  }
  const refused = refusePluginRequest(req, settings.liveOrigins);
  if (refused?.kind === "OriginNotAllowed" && (await isStagingOrigin(req, adapter))) {
    // #1326 interim (until staging has its own gateway, #1329/#1330): a
    // staged page's plugin call is refused without a failed request in
    // the browser, so the Stage audit does not count it as a page error.
    // Nothing is dispatched or written.
    return new Response(STAGING_PLUGIN_STUB_BODY, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  }
  if (refused) {
    return errorResponse(refused.kind, refused.status, requestId, {
      log: `${req.headers.get("content-type") ?? "no content-type"} from ${req.headers.get("origin") ?? "no origin"} to ${slug}.${operationName}`,
    });
  }
  const served = await servedToVisitors(slug, operationName);
  if (served === "unpublished") {
    return errorResponse("ProjectionNotPublished", 503, requestId, {
      log: unpublishedRegistryError()?.message ?? "plugin registry not published",
    });
  }
  if (served === "unknown") return errorResponse("NotFound", 404, requestId);
  const opLimited = operationRateLimited(`${slug}.${operationName}`, requestId);
  if (opLimited) return opLimited;
  await sweepGatewayStateIfDue?.();

  const start = performance.now();
  const logRow = (
    row: Omit<RequestLogRow, "pluginSlug" | "operation" | "durationMs" | "bodyBytes">,
    bodyBytes: number,
  ) =>
    recordRequest({
      pluginSlug: slug,
      operation: operationName,
      durationMs: Math.round(performance.now() - start),
      bodyBytes,
      ...row,
    });

  // 1. Body size cap.
  const cap = await readBodyWithCap(req, settings.maxBodyBytes);
  if (!cap.ok) {
    await logRow(
      {
        statusCode: 413,
        wasRateLimited: false,
        wasHoneypotCaught: false,
        captchaPassed: false,
        errorKind: "PayloadTooLarge",
      },
      cap.bytes,
    );
    return errorResponse("PayloadTooLarge", 413, requestId);
  }
  let body: unknown;
  try {
    body = cap.bytes > 0 ? JSON.parse(new TextDecoder().decode(cap.body)) : {};
  } catch {
    return errorResponse("BadRequest", 400, requestId);
  }

  // 2. Resolve the visitor — an id only with the visitor's consent (#677).
  const resolved = await resolveConsentedVisitor(req, settings, requestId);
  if (!resolved.ok) return resolved.response;
  const { visitor } = resolved;
  const cookies: string[] = [...visitor.setCookies];

  // Every rate limit is keyed by the client address the deployment's
  // proxies vouch for (client-ip.ts), never by an entry the client wrote
  // and never by the visitor cookie: a client can drop, rotate or withhold
  // a cookie at will, so a cookie-keyed budget would be no limit at all.
  // Visitors behind one NAT share a budget — the usual trade-off.
  const ipHash = await clientIpHash(clientIp);
  const plugin = loadedPlugins.bySlug(slug);
  // Only a served operation reaches this line, so the spec cache holds
  // real operations only (#1326 M1).
  const spec = await resolveRateLimitSpec(adapter, slug, operationName, plugin);

  // 3. Honeypot edge-evict — lie to the bot, never touch the DB beyond its
  // bucket. P13 audit fix #5 — DO NOT mint a fresh visitor cookie for caught
  // bots: nothing a bot does should hand it a stable identity. An
  // IP-scoped bucket throttles sustained spam from one address; once it is
  // spent the bot gets the 429 (#1326: its decision used to be discarded).
  const hp = checkHoneypot(body);
  if (hp.tripped) {
    const honeypotRl = await consumeRateLimit(adapter, {
      key: ipScopedRateLimitKey(slug, "honeypot", ipHash),
      spec,
    });
    await logRow(
      {
        statusCode: honeypotRl.allowed ? 200 : 429,
        wasRateLimited: !honeypotRl.allowed,
        wasHoneypotCaught: true,
        captchaPassed: false,
      },
      cap.bytes,
    );
    if (!honeypotRl.allowed) {
      return errorResponse("RateLimited", 429, requestId, {
        retryAfterSec: honeypotRl.retryAfterSec,
      });
    }
    return jsonResponse({ ok: true, data: { accepted: true } });
  }

  // 4. Rate limit. The registry was synced by the served check above, so a
  // plugin an Owner just activated (or disabled) is seen with its
  // manifest's limits.
  const rl = await consumeRateLimit(adapter, {
    key: ipScopedRateLimitKey(slug, operationName, ipHash),
    spec,
  });
  if (!rl.allowed) {
    await logRow(
      {
        statusCode: 429,
        wasRateLimited: true,
        wasHoneypotCaught: false,
        captchaPassed: false,
        errorKind: "RateLimited",
      },
      cap.bytes,
    );
    return errorResponse("RateLimited", 429, requestId, {
      setCookies: cookies,
      retryAfterSec: rl.retryAfterSec,
    });
  }

  // 5. Captcha verify (when caller supplied one + provider is PoW).
  let captchaPassed = false;
  if (settings.captcha.provider === "pow") {
    const proof = (body as { _caelo_captcha?: { challenge: string; nonce: string } })
      ._caelo_captcha;
    if (proof) {
      const verify = await verifyPowProof(adapter, proof);
      if (!verify.ok) {
        await logRow(
          {
            statusCode: 403,
            wasRateLimited: false,
            wasHoneypotCaught: false,
            captchaPassed: false,
            errorKind: "CaptchaFailed",
          },
          cap.bytes,
        );
        return errorResponse("CaptchaFailed", 403, requestId, {
          setCookies: cookies,
          log: verify.reason,
        });
      }
      captchaPassed = true;
    }
  }

  // 6. Plugin host dispatch.
  const sessionMutation: {
    current:
      | { kind: "none" }
      | { kind: "set"; sessionToken: string; expiresAt: string }
      | { kind: "clear" };
  } = { current: { kind: "none" } };

  // The visitor id reaches only a plugin that declared it as a consent
  // purpose; the visitor agreed to that plugin's use of it, not to every
  // plugin on the site reading it.
  const visitorId = pluginDeclaresConsentPurpose(slug, VISITOR_ID_PURPOSE)
    ? visitor.visitorId
    : null;
  const result = await runPluginOperation({
    pluginSlug: slug,
    operationName,
    args: body,
    invocation: { origin: "visitor", actorId: visitorId ?? ANONYMOUS_VISITOR_ACTOR },
    visitorContext: {
      visitorId,
      sessionToken: visitor.sessionToken,
      sessionMutation,
      // The plugin's ctx.captcha.requireProof answers from this (#634).
      captcha: { enforced: settings.captcha.provider !== "off", proofVerified: captchaPassed },
    },
  });

  if (sessionMutation.current.kind === "set") {
    const expiresMs = Math.max(
      1,
      Math.floor((new Date(sessionMutation.current.expiresAt).getTime() - Date.now()) / 1000),
    );
    const signed = await signCookieValue({
      value: sessionMutation.current.sessionToken,
      secret: settings.cookieSecret,
    });
    cookies.push(sessionCookieHeader({ value: signed, maxAge: expiresMs }));
  } else if (sessionMutation.current.kind === "clear") {
    cookies.push(clearSessionCookieHeader());
  }

  if (!result.ok) {
    const status =
      result.error.kind === "PluginNotFound"
        ? 404
        : result.error.kind === "PluginDisabled" || result.error.kind === "ProjectionNotPublished"
          ? 503
          : result.error.kind === "OperationNotDeclared"
            ? 400
            : // A caller probing for an admin-only operation learns only
              // that this path serves nothing — the 404 does not confirm
              // that the operation exists.
              result.error.kind === "OperationNotPublic"
              ? 404
              : 500;
    await logRow(
      {
        statusCode: status,
        wasRateLimited: false,
        wasHoneypotCaught: false,
        captchaPassed,
        errorKind: result.error.kind,
      },
      cap.bytes,
    );
    // The plugin's message (an exception's text, #763 M4) stays in the log.
    return errorResponse(result.error.kind, status, requestId, {
      setCookies: cookies,
      log: `${slug}.${operationName}: ${result.error.message ?? "no message"}`,
    });
  }
  await logRow(
    { statusCode: 200, wasRateLimited: false, wasHoneypotCaught: false, captchaPassed },
    cap.bytes,
  );
  return jsonResponse({ ok: true, data: result.value }, { setCookies: cookies });
}

// ---------------------------------------------------------------------------
// Main — Bun.serve. Only fires when this file is invoked as the entrypoint.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Refuse to serve without knowing which forwarded address is the visitor
  // (client-ip.ts): every rate limit and the staging allowlist depend on it.
  const hops = trustedProxyHopsFromEnv(process.env);
  console.log(
    `[api-gateway] client address: ${hops === 0 ? "the TCP peer (no proxy in front)" : `X-Forwarded-For entry ${hops} from the end`}`,
  );
  const urls = gatewayDatabaseUrls(process.env);
  // No cms_admin pool at all (#635): every path that would reach the
  // authoring database throws AdminDatabaseUnavailableError. verifyRoles
  // fails loudly if the URL resolves to anything but public_role.
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  // Ask the database too (#635): a login that can reach cms_admin, or a
  // bridge out of cms_public, is refused before the first request.
  await adapter.verifyRoles();
  const isolation = await databaseIsolationProblems(adapter.rawPublic());
  if (isolation.length > 0) {
    const lines = isolation.map((p) => `  - ${p}`).join("\n");
    throw new Error(
      `the API gateway's database login is not isolated from cms_admin (CLAUDE.md §2):\n${lines}\nRun the migrations (their role audit names the fix) or \`cms-provision upgrade\`.`,
    );
  }
  // Exactly the core operations visitor paths need (#634), all on cms_public.
  const registry = new OperationRegistry();
  registerGatewayOperations(registry);
  setGatewayAdapter(adapter);
  // #1267 — the admin's publisher notifies cms_public after every publish
  // (#635). The caches of published state are served only while this LISTEN
  // is acknowledged (published-changes.ts); boot waits for it, so a gateway
  // that cannot listen fails here instead of serving stale state.
  onPublishedChange(invalidateGatewaySettings);
  onPublishedChange(invalidateRateLimitSpecCache);
  await listenForPublishedChanges(adapter);
  // #387 one-trust-path: same dev auto-signing + verified disk load as
  // the admin host. Non-production boots regenerate stale manifests
  // with the repo dev key; the loader verifies via the trust-root drop
  // file (or the embedded release key in production).
  if (process.env.NODE_ENV !== "production") {
    const signed = await ensureDevSignedManifests({
      pluginsRoot: PLUGINS_ROOT,
      keyPath: resolve(PLUGINS_ROOT, "../../.caelo-dev-key"),
    });
    for (const r of signed.reports) {
      if (r.status === "failed" || r.status === "skipped") {
        console.warn(`[api-gateway] plugin dev-sign ${r.status}: ${r.slug} — ${r.reason}`);
      }
    }
  }
  // Dispatch-only: verify what this image ships, attach what the admin's
  // registry marks active, write nothing (#613).
  const report = await bootstrapDispatchOnly({
    infra: { adapter, registry },
    pluginsRoot: PLUGINS_ROOT,
    systemActorId: SYSTEM_ACTOR_ID,
  });
  // #387 — a discarded LoadReport hid the "5/6 plugins failed" class of
  // boot problem entirely. Failures are operator-relevant; log loudly.
  console.log(
    `[api-gateway] plugin host: ${report.loaded.length} loaded${report.loaded.length > 0 ? ` (${report.loaded.map((l) => l.slug).join(", ")})` : ""}`,
  );
  for (const f of report.failed) {
    console.error(`[api-gateway] plugin FAILED to load: ${f.slug} — ${f.reason}`);
  }
  const server = Bun.serve({
    port: PORT,
    // #1326 — explicit, not Bun's 128 MB default: no route reads more.
    maxRequestBodySize: SERVER_MAX_REQUEST_BODY_BYTES,
    fetch: (req, srv) =>
      handleRequest(req, {
        peerAddress: srv.requestIP(req)?.address ?? null,
        setIdleTimeout: (seconds) => srv.timeout(req, seconds),
      }),
  });
  console.log(`[api-gateway] listening on :${server.port}`);
}
