// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo API gateway — public-facing HTTP entry point for plugin operations.
 *
 * Routes:
 *   POST /api/plugin/<slug>/<operation>     JSON body → JSON response
 *   GET  /api/captcha/challenge             PoW challenge envelope
 *   GET  /healthz                           liveness probe
 *   GET  /api/_caelo/health[?deep=1]        upgrade health check (health.ts)
 *   *    (Host: staging.<domain>)           #650 staging gate + proxy to the
 *                                           staged build (staging-proxy.ts)
 *
 * Each public-write request flows through (in order):
 *   1. Body-size cap (default 64 KB; 1 MB hard ceiling).
 *   2. Resolve signed visitor cookie + signed session cookie (HMAC-SHA256).
 *      The visitor id exists only with the visitor's consent to the
 *      category that covers it (#677, visitor.ts): no decision, "reject
 *      all" or no consent provider → no id, no Set-Cookie, and any id the
 *      browser still holds is expired. Tampered → a fresh id (consented).
 *   3. Honeypot edge-evict — bot-filled `hp_address` returns {ok:true}
 *      immediately, no DB writes, no audit, no rate-limit consumption.
 *   4. Per-(plugin, op, visitor) rate limit + token-bucket burst gate —
 *      keyed by client IP for every visitor the gateway does not
 *      recognise. 429 with Retry-After when exceeded.
 *   5. Captcha verify (when configured + plugin op opts in via
 *      `_caelo_captcha`). PoW provider in v1; Turnstile/hCaptcha later.
 *   6. Plugin host dispatch + sessionMutation cookie emission.
 *   7. Request log row written async (best-effort; failure does not
 *      affect the response).
 *
 * Database identity (issue #613, CLAUDE.md §2): the gateway never holds an
 * admin_role credential. It reaches cms_admin as `gateway_role` — read
 * access to its settings and the plugin registry, append access to its own
 * state (rate-limit buckets, captcha challenges, request log, plugin op
 * audit), nothing else (migration 0248) — and cms_public as `public_role`.
 * Its plugin host only attaches what the admin registered and an Owner
 * activated (plugin-host gateway-attach.ts); it never registers, provisions
 * or activates anything itself. Its OperationRegistry holds only the core
 * operations visitor paths call (plugin-host gateway-ops.ts, #634).
 */

import { resolve } from "node:path";
import {
  bootstrapDispatchOnly,
  ensureDevSignedManifests,
  loadedPlugins,
  registerGatewayOperations,
  runPluginOperation,
  syncDispatchPlugins,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
// Read SQL via globalThis.Bun rather than a value-import of "bun".
// The type-only import is erased at compile; the runtime constructor
// comes from Bun's globals. Keeps this file bundler-safe for any
// downstream packager that doesn't resolve the bun built-in.
import type { SQL as SQLType } from "bun";
import { sql } from "drizzle-orm";

const SQL = (globalThis as { Bun?: { SQL: new (url: string) => SQLType } }).Bun
  ?.SQL as unknown as new (
  url: string,
) => SQLType;

import { GATEWAY_DATABASE_ROLES, gatewayDatabaseUrls } from "./database-env.js";
import { GATEWAY_HEALTH_PATH, gatewayHealth } from "./health.js";
import { readBodyWithCap } from "./middleware/body-cap.js";
import {
  type CaptchaConfig,
  clientIpHash,
  issuePowChallenge,
  verifyPowProof,
} from "./middleware/captcha.js";
import { checkHoneypot } from "./middleware/honeypot.js";
import {
  consumeRateLimit,
  invalidateRateLimitSpecCache,
  ipScopedRateLimitKey,
  rateLimitKey,
  resolveRateLimitSpec,
} from "./middleware/rate-limit.js";
import { signCookieValue } from "./middleware/signed-cookie.js";
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
} from "./visitor.js";

export {
  ADMIN_CREDENTIAL_ENV,
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
// Site settings cache — gateway secret + body cap + captcha provider live
// in `site_settings`. Refresh every 30s; rotation effects propagate within
// that window.
// ---------------------------------------------------------------------------

interface GatewaySettings {
  cookieSecret: string;
  maxBodyBytes: number;
  captcha: CaptchaConfig;
}

// P13 audit fix #2 — short TTL so cookie-secret rotations propagate
// quickly. The in-process invalidation path lives via the
// admin-issued `gateway.rotate_cookie_secret` op which posts a
// `pg_notify('caelo_gateway_settings', '')`; the gateway's LISTEN
// connection invalidates immediately. The 5s ceiling is the safety
// net for cross-process / multi-replica deployments where NOTIFY
// reaches one replica only.
const SETTINGS_TTL_MS = 5_000;
let cachedSettings: { settings: GatewaySettings; loadedAt: number } | null = null;

async function loadSettings(adapter: DatabaseAdapter): Promise<GatewaySettings> {
  if (cachedSettings && Date.now() - cachedSettings.loadedAt < SETTINGS_TTL_MS) {
    return cachedSettings.settings;
  }
  const rows = await adapter.withAdminTransaction(
    SYSTEM_CTX,
    async (tx) =>
      (await tx.execute(sql`
      SELECT
        gateway_cookie_secret      AS cookie_secret,
        gateway_max_body_bytes     AS max_body_bytes,
        captcha_provider           AS captcha_provider,
        captcha_pow_target_prefix  AS captcha_pow_target_prefix
      FROM site_settings
      WHERE id = 1
      LIMIT 1
    `)) as unknown as {
        cookie_secret: string | null;
        max_body_bytes: number;
        captcha_provider: "off" | "pow" | "turnstile" | "hcaptcha";
        captcha_pow_target_prefix: string;
      }[],
  );
  const row = rows[0];
  const secret = row?.cookie_secret;
  if (!row || !secret) {
    // Migration 0248 seeds the secret and the admin rotates it; the gateway
    // has no write access to site_settings (#613), so it cannot mint one.
    throw new GatewayNotReadyError(
      row
        ? "site_settings.gateway_cookie_secret is not set; run the database migrations (0248 seeds it) or rotate it from /settings/gateway"
        : "site_settings has no row; run the database migrations",
    );
  }
  const settings: GatewaySettings = {
    cookieSecret: secret,
    maxBodyBytes: row?.max_body_bytes ?? 65536,
    captcha: {
      provider: row?.captcha_provider ?? "pow",
      powTargetPrefix: row?.captcha_pow_target_prefix ?? "000fff",
    },
  };
  cachedSettings = { settings, loadedAt: Date.now() };
  return settings;
}

/** The gateway cannot serve yet; answered as 503 with the reason. */
export class GatewayNotReadyError extends Error {
  override readonly name = "GatewayNotReadyError";
}

/**
 * The 503 for settings that could not be loaded. Only the gateway's own
 * readiness reason ({@link GatewayNotReadyError}) reaches the caller; any
 * other failure (an unreachable database, a refused login, a broken query)
 * would hand an unauthenticated visitor hosts, role names or SQL, so it is
 * logged here and the visitor gets a generic message.
 */
export function settingsUnavailable(e: unknown): Response {
  if (e instanceof GatewayNotReadyError) {
    return jsonResponse(
      { ok: false, error: { kind: "ServiceUnavailable", message: e.message } },
      { status: 503 },
    );
  }
  console.error(`[api-gateway] gateway settings could not be loaded: ${describeFailure(e)}`);
  return jsonResponse(
    {
      ok: false,
      error: { kind: "ServiceUnavailable", message: "the gateway is temporarily unavailable" },
    },
    { status: 503 },
  );
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

export function invalidateGatewaySettings(): void {
  cachedSettings = null;
  cachedStagingState = null;
  invalidateVisitorConsentRule();
}

// ---------------------------------------------------------------------------
// Staging gate state (#650) — the staging_access row: access modes and the
// current staged build's origin. Same short TTL + NOTIFY invalidation as
// the settings above (the admin notifies on every change and every Stage).
// ---------------------------------------------------------------------------

let cachedStagingState: { state: StagingState; loadedAt: number } | null = null;

async function loadStagingState(adapter: DatabaseAdapter): Promise<StagingState> {
  if (cachedStagingState && Date.now() - cachedStagingState.loadedAt < SETTINGS_TTL_MS) {
    return cachedStagingState.state;
  }
  const rows = (await adapter.withAdminTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`
        SELECT staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce,
               header_enabled, header_name, header_nonce,
               to_jsonb(ip_allowlist) AS ip_allowlist, origin_url
        FROM staging_access WHERE id = 1
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
    throw new GatewayNotReadyError("staging_access has no row; run the database migrations (0251)");
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
  cachedStagingState = { state, loadedAt: Date.now() };
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
      sign: (value) => signCookieValue({ value, secret: settings.cookieSecret }),
    });
    return { ok: true, visitor };
  } catch (e) {
    console.error(`[api-gateway] visitor consent could not be resolved: ${describeFailure(e)}`);
    return {
      ok: false,
      response: jsonResponse(
        {
          ok: false,
          error: {
            kind: "ConsentUnavailable",
            message:
              "the site's consent settings could not be read, so this request was not processed",
          },
        },
        { status: 503 },
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Request log — best-effort append.
// ---------------------------------------------------------------------------

interface RequestLogRow {
  pluginSlug: string;
  operation: string;
  visitorIdHash: string;
  statusCode: number;
  durationMs: number;
  bodyBytes: number;
  wasRateLimited: boolean;
  wasHoneypotCaught: boolean;
  captchaPassed: boolean;
  errorKind?: string | null;
}

let cachedAdapter: DatabaseAdapter | null = null;
export function setGatewayAdapter(adapter: DatabaseAdapter): void {
  cachedAdapter = adapter;
}

async function recordRequest(row: RequestLogRow): Promise<void> {
  if (!cachedAdapter) return;
  try {
    await cachedAdapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
      await tx.execute(sql`
        INSERT INTO gateway_request_log (
          plugin_slug, operation, visitor_id_hash, status_code, duration_ms,
          body_bytes, was_rate_limited, was_honeypot_caught, captcha_passed, error_kind
        ) VALUES (
          ${row.pluginSlug}, ${row.operation}, ${row.visitorIdHash}, ${row.statusCode},
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

const PLUGIN_PATH_RE = /^\/api\/plugin\/([a-z][a-z0-9-]*)\/([a-z_][a-z0-9_]*)$/;

function jsonResponse(
  body: unknown,
  init: { status?: number; setCookies?: string[]; retryAfterSec?: number } = {},
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  for (const c of init.setCookies ?? []) headers.append("Set-Cookie", c);
  if (init.retryAfterSec !== undefined) {
    headers.set("Retry-After", String(init.retryAfterSec));
  }
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

// ---------------------------------------------------------------------------
// Main handler.
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request): Promise<Response> {
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
      return handleStagingRequest(req, {
        config: { stagingOrigin: `https://${loaded.host}`, secret: stagingGate.secret },
        loadState: async () => loaded,
      });
    }
  }

  if (url.pathname === "/healthz") {
    return jsonResponse({ ok: true });
  }
  if (req.method === "GET" && url.pathname === GATEWAY_HEALTH_PATH) {
    return gatewayHealth(url, cachedAdapter);
  }

  if (!cachedAdapter) {
    return jsonResponse(
      { ok: false, error: { kind: "ServiceUnavailable", message: "gateway not bootstrapped" } },
      { status: 503 },
    );
  }
  let settings: GatewaySettings;
  try {
    settings = await loadSettings(cachedAdapter);
  } catch (e) {
    return settingsUnavailable(e);
  }

  // ---- Captcha challenge endpoint ----
  if (req.method === "GET" && url.pathname === "/api/captcha/challenge") {
    if (settings.captcha.provider === "off") {
      return new Response(null, { status: 204 });
    }
    if (settings.captcha.provider !== "pow") {
      return jsonResponse(
        {
          ok: false,
          error: {
            kind: "NotImplemented",
            message: `provider ${settings.captcha.provider} not yet wired`,
          },
        },
        { status: 501 },
      );
    }
    const resolved = await resolveConsentedVisitor(req, settings);
    if (!resolved.ok) return resolved.response;
    const { visitor } = resolved;
    const challenge = await issuePowChallenge(cachedAdapter, {
      config: settings.captcha,
      visitorIdHash: visitor.visitorIdHash,
    });
    return jsonResponse({ ok: true, data: challenge }, { setCookies: [...visitor.setCookies] });
  }

  // ---- Plugin dispatch ----
  if (req.method !== "POST" || !url.pathname.startsWith("/api/plugin/")) {
    return jsonResponse({ ok: false, error: { kind: "NotFound" } }, { status: 404 });
  }
  const match = PLUGIN_PATH_RE.exec(url.pathname);
  if (!match) {
    return jsonResponse(
      { ok: false, error: { kind: "BadRequest", message: "invalid plugin route" } },
      { status: 400 },
    );
  }
  const [, slug, operationName] = match;
  if (!slug || !operationName) {
    return jsonResponse({ ok: false, error: { kind: "BadRequest" } }, { status: 400 });
  }

  const start = performance.now();

  // 1. Body size cap.
  const cap = await readBodyWithCap(req, settings.maxBodyBytes);
  if (!cap.ok) {
    void recordRequest({
      pluginSlug: slug,
      operation: operationName,
      visitorIdHash: "",
      statusCode: 413,
      durationMs: Math.round(performance.now() - start),
      bodyBytes: cap.bytes,
      wasRateLimited: false,
      wasHoneypotCaught: false,
      captchaPassed: false,
      errorKind: "PayloadTooLarge",
    });
    return jsonResponse(
      {
        ok: false,
        error: {
          kind: "PayloadTooLarge",
          message: `body exceeded ${cap.limit} bytes (saw ${cap.bytes})`,
        },
      },
      { status: 413 },
    );
  }
  let body: unknown;
  try {
    body = cap.bytes > 0 ? JSON.parse(new TextDecoder().decode(cap.body)) : {};
  } catch {
    return jsonResponse(
      { ok: false, error: { kind: "BadRequest", message: "expected JSON body" } },
      { status: 400 },
    );
  }

  // 2. Resolve the visitor — an id only with the visitor's consent (#677).
  const resolved = await resolveConsentedVisitor(req, settings);
  if (!resolved.ok) return resolved.response;
  const { visitor } = resolved;
  const cookies: string[] = [...visitor.setCookies];

  // P13 audit re-pass — derive an IP-scoped key once. Used on:
  //   (a) the honeypot branch (so bots can't inflate rate_limit_buckets
  //       by spinning fresh uuids — the IP pins the bucket),
  //   (b) any request from a visitor the gateway does not recognise — no
  //       signed cookie, a freshly minted one, or no consent to one
  //       (#677) — so a single IP can't bypass throttling by rotating or
  //       withholding cookies.
  // Recognised visitors (a signed visitor cookie they already held, with
  // consent) get the per-visitor key (fairer rate budgets when many users
  // share an IP via NAT).
  const ipHash = clientIpHash(req);
  const visitorRateKey =
    visitor.recognised && visitor.visitorId
      ? rateLimitKey(slug, operationName, visitor.visitorId)
      : ipScopedRateLimitKey(slug, operationName, ipHash);

  // 3. Honeypot edge-evict — lie to the bot, never touch the DB.
  // P13 audit fix #5 — DO NOT mint a fresh visitor cookie for caught
  // bots. Issuing a stable Set-Cookie hands them a valid identity they
  // can re-use to bypass per-visitor rate limits on real submission
  // paths. Drop the cookies array on this branch; the bot pays a fresh
  // PoW + rate-limit bucket on every retry.
  // P13 audit re-pass — also consume an IP-scoped rate-limit token so
  // sustained spam from a single IP eventually gets throttled.
  const hp = checkHoneypot(body);
  if (hp.tripped) {
    const honeypotSpec = await resolveRateLimitSpec(cachedAdapter, slug, operationName);
    await consumeRateLimit(cachedAdapter, {
      key: ipScopedRateLimitKey(slug, "honeypot", ipHash),
      spec: honeypotSpec,
    }).catch(() => undefined);
    void recordRequest({
      pluginSlug: slug,
      operation: operationName,
      visitorIdHash: visitor.visitorIdHash,
      statusCode: 200,
      durationMs: Math.round(performance.now() - start),
      bodyBytes: cap.bytes,
      wasRateLimited: false,
      wasHoneypotCaught: true,
      captchaPassed: false,
    });
    return jsonResponse({ ok: true, data: { accepted: true } });
  }

  // 4. Rate limit. The registry was synced while resolving the visitor
  // (step 2), so a plugin an Owner just activated (or disabled) is seen
  // with its manifest's limits.
  const plugin = loadedPlugins.bySlug(slug);
  const spec = await resolveRateLimitSpec(cachedAdapter, slug, operationName, plugin);
  const rl = await consumeRateLimit(cachedAdapter, {
    key: visitorRateKey,
    spec,
  });
  if (!rl.allowed) {
    void recordRequest({
      pluginSlug: slug,
      operation: operationName,
      visitorIdHash: visitor.visitorIdHash,
      statusCode: 429,
      durationMs: Math.round(performance.now() - start),
      bodyBytes: cap.bytes,
      wasRateLimited: true,
      wasHoneypotCaught: false,
      captchaPassed: false,
      errorKind: "RateLimited",
    });
    return jsonResponse(
      {
        ok: false,
        error: {
          kind: "RateLimited",
          message: `rate limit exceeded (${spec.perVisitorMax} per ${spec.windowSeconds}s)`,
        },
      },
      { status: 429, setCookies: cookies, retryAfterSec: rl.retryAfterSec },
    );
  }

  // 5. Captcha verify (when caller supplied one + provider is PoW).
  let captchaPassed = false;
  if (settings.captcha.provider === "pow") {
    const proof = (body as { _caelo_captcha?: { challenge: string; nonce: string } })
      ._caelo_captcha;
    if (proof) {
      const verify = await verifyPowProof(cachedAdapter, proof);
      if (!verify.ok) {
        void recordRequest({
          pluginSlug: slug,
          operation: operationName,
          visitorIdHash: visitor.visitorIdHash,
          statusCode: 403,
          durationMs: Math.round(performance.now() - start),
          bodyBytes: cap.bytes,
          wasRateLimited: false,
          wasHoneypotCaught: false,
          captchaPassed: false,
          errorKind: "CaptchaFailed",
        });
        return jsonResponse(
          { ok: false, error: { kind: "CaptchaFailed", message: verify.reason } },
          { status: 403, setCookies: cookies },
        );
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

  const result = await runPluginOperation({
    pluginSlug: slug,
    operationName,
    args: body,
    invocation: { origin: "visitor", actorId: visitor.visitorId ?? ANONYMOUS_VISITOR_ACTOR },
    visitorContext: {
      visitorId: visitor.visitorId,
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
        : result.error.kind === "PluginDisabled"
          ? 503
          : result.error.kind === "OperationNotDeclared"
            ? 400
            : // A caller probing for an admin-only operation learns only
              // that this path serves nothing — the 404 does not confirm
              // that the operation exists.
              result.error.kind === "OperationNotPublic"
              ? 404
              : 500;
    void recordRequest({
      pluginSlug: slug,
      operation: operationName,
      visitorIdHash: visitor.visitorIdHash,
      statusCode: status,
      durationMs: Math.round(performance.now() - start),
      bodyBytes: cap.bytes,
      wasRateLimited: false,
      wasHoneypotCaught: false,
      captchaPassed,
      errorKind: result.error.kind,
    });
    return jsonResponse({ ok: false, error: result.error }, { status, setCookies: cookies });
  }
  void recordRequest({
    pluginSlug: slug,
    operation: operationName,
    visitorIdHash: visitor.visitorIdHash,
    statusCode: 200,
    durationMs: Math.round(performance.now() - start),
    bodyBytes: cap.bytes,
    wasRateLimited: false,
    wasHoneypotCaught: false,
    captchaPassed,
  });
  return jsonResponse({ ok: true, data: result.value }, { setCookies: cookies });
}

// ---------------------------------------------------------------------------
// Main — Bun.serve. Only fires when this file is invoked as the entrypoint.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const urls = gatewayDatabaseUrls(process.env);
  // The "admin" pool is the cms_admin pool, opened as gateway_role.
  // verifyRoles fails loudly if either URL resolves to another role.
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: urls.gateway,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  // Exactly the core operations visitor paths need (#634); gateway_role's
  // grants cover these and nothing more.
  const registry = new OperationRegistry();
  registerGatewayOperations(registry);
  setGatewayAdapter(adapter);
  // P13 audit re-pass — dedicated long-lived LISTEN connection.
  // Pooled handles return to the pool after each query, dropping any
  // pg_notify subscriptions; so we open a SEPARATE Bun.SQL client that
  // stays open for the gateway's lifetime, runs LISTEN, and yields a
  // streaming iterable of notifications. The 5s TTL is the safety net
  // when this fails (e.g. during DB restart) so we don't block boot.
  void (async () => {
    try {
      const listenSql = new SQL(urls.gateway);
      // Bun's `unsafe` runs LISTEN on the bound connection; subsequent
      // notifications stream via `for await` on the connection's
      // notifications iterator.
      const conn = listenSql as unknown as {
        unsafe: (q: string) => Promise<unknown>;
        notifications?: AsyncIterable<{ channel: string; payload?: string }>;
      };
      await conn.unsafe("LISTEN caelo_gateway_settings");
      if (!conn.notifications) return;
      for await (const n of conn.notifications) {
        if (n.channel === "caelo_gateway_settings") {
          invalidateGatewaySettings();
          invalidateRateLimitSpecCache();
        }
      }
    } catch {
      // best-effort; 5s TTL on cachedSettings covers the gap.
    }
  })();
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
    fetch: handleRequest,
  });
  console.log(`[api-gateway] listening on :${server.port}`);
}
