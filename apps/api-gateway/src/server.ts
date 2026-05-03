// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo API gateway — public-facing HTTP entry point for plugin operations.
 *
 * Routes:
 *   POST /api/plugin/<slug>/<operation>     JSON body → JSON response
 *   GET  /api/captcha/challenge             PoW challenge envelope
 *   GET  /healthz                           liveness probe
 *
 * Each public-write request flows through (in order):
 *   1. Body-size cap (default 64 KB; 1 MB hard ceiling).
 *   2. Resolve signed visitor cookie + signed session cookie (HMAC-SHA256).
 *      Tampered → treat as fresh visitor.
 *   3. Honeypot edge-evict — bot-filled `hp_address` returns {ok:true}
 *      immediately, no DB writes, no audit, no rate-limit consumption.
 *   4. Per-(plugin, op, visitor) rate limit + token-bucket burst gate.
 *      429 with Retry-After when exceeded.
 *   5. Captcha verify (when configured + plugin op opts in via
 *      `_caelo_captcha`). PoW provider in v1; Turnstile/hCaptcha later.
 *   6. Plugin host dispatch + sessionMutation cookie emission.
 *   7. Request log row written async (best-effort; failure does not
 *      affect the response).
 */

import { resolve } from "node:path";
import {
  bootstrap as bootstrapPluginHost,
  loadedPlugins,
  runPluginOperation,
} from "@caelo/plugin-host";
import { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { handleVariantAssign, VARIANT_SCRIPT } from "./ab-router.js";
import { readBodyWithCap } from "./middleware/body-cap.js";
import {
  type CaptchaConfig,
  clientIpHash,
  hashVisitorId,
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
import {
  generateCookieSecret,
  signCookieValue,
  verifySignedCookie,
} from "./middleware/signed-cookie.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL ?? process.env.PUBLIC_ADMIN_DATABASE_URL;
const SYSTEM_ACTOR_ID = process.env.CAELO_SYSTEM_ACTOR_ID ?? "00000000-0000-0000-0000-00000000ffff";
const PORT = Number.parseInt(process.env.GATEWAY_PORT ?? "8090", 10);
const PLUGINS_ROOT = resolve(import.meta.dir, "../../../packages/plugins");

const VISITOR_COOKIE = "caelo_visitor_id";
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE = "caelo_session";

const SYSTEM_CTX = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "gateway",
};

// ---------------------------------------------------------------------------
// Cookie helpers (signed via HMAC-SHA256).
// ---------------------------------------------------------------------------

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    out[name] = value;
  }
  return out;
}

export function visitorCookieHeader(value: string): string {
  const flags = [
    `${VISITOR_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}

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
  let secret = row?.cookie_secret;
  if (!secret) {
    secret = generateCookieSecret();
    await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
      await tx.execute(sql`
        UPDATE site_settings SET gateway_cookie_secret = ${secret} WHERE id = 1
      `);
    });
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

export function invalidateGatewaySettings(): void {
  cachedSettings = null;
}

// ---------------------------------------------------------------------------
// Visitor resolution — verifies signed cookies; falls back to fresh ids.
// ---------------------------------------------------------------------------

export interface ResolvedVisitor {
  visitorId: string;
  visitorIdHash: string;
  isFresh: boolean;
  sessionToken: string | null;
}

export async function resolveVisitor(req: Request, secret: string): Promise<ResolvedVisitor> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const rawVisitor = cookies[VISITOR_COOKIE] ?? "";
  const rawSession = cookies[SESSION_COOKIE] ?? "";

  let visitorId: string | null = null;
  if (rawVisitor) {
    const v = await verifySignedCookie({
      signed: rawVisitor,
      secret,
      maxAgeSeconds: VISITOR_COOKIE_MAX_AGE,
    });
    if (v && /^[0-9a-fA-F-]{36}$/.test(v.value)) visitorId = v.value;
  }
  let isFresh = false;
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    isFresh = true;
  }

  let sessionToken: string | null = null;
  if (rawSession) {
    const s = await verifySignedCookie({ signed: rawSession, secret });
    if (s && /^[0-9a-fA-F]{64}$/.test(s.value)) sessionToken = s.value;
  }

  return { visitorId, visitorIdHash: hashVisitorId(visitorId), isFresh, sessionToken };
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
let cachedRegistry: OperationRegistry | null = null;
export function setGatewayAdapter(adapter: DatabaseAdapter): void {
  cachedAdapter = adapter;
}
export function setGatewayRegistry(registry: OperationRegistry): void {
  cachedRegistry = registry;
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

  if (url.pathname === "/healthz") {
    return jsonResponse({ ok: true });
  }

  // ---- A/B variant inline script ----
  if (req.method === "GET" && url.pathname === "/api/variant.js") {
    return new Response(VARIANT_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  if (!cachedAdapter) {
    return jsonResponse(
      { ok: false, error: { kind: "ServiceUnavailable", message: "gateway not bootstrapped" } },
      { status: 503 },
    );
  }
  const settings = await loadSettings(cachedAdapter);

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
    const visitor = await resolveVisitor(req, settings.cookieSecret);
    const challenge = await issuePowChallenge(cachedAdapter, {
      config: settings.captcha,
      visitorIdHash: visitor.visitorIdHash,
    });
    const cookies: string[] = [];
    if (visitor.isFresh) {
      const signed = await signCookieValue({
        value: visitor.visitorId,
        secret: settings.cookieSecret,
      });
      cookies.push(visitorCookieHeader(signed));
    }
    return jsonResponse({ ok: true, data: challenge }, { setCookies: cookies });
  }

  // ---- A/B variant assignment ----
  if (req.method === "POST" && url.pathname === "/api/variant/assign") {
    if (!cachedRegistry) {
      return jsonResponse({ ok: false, error: { kind: "ServiceUnavailable" } }, { status: 503 });
    }
    const expSlug = url.searchParams.get("exp") ?? "";
    if (!expSlug) {
      return jsonResponse(
        { ok: false, error: { kind: "BadRequest", message: "exp required" } },
        { status: 400 },
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(
        { ok: false, error: { kind: "BadRequest", message: "expected JSON body" } },
        { status: 400 },
      );
    }
    const visitor = await resolveVisitor(req, settings.cookieSecret);
    const r = await handleVariantAssign({
      adapter: cachedAdapter,
      registry: cachedRegistry,
      expSlug,
      body: body as { visitorId: string; page: string },
      visitorIdHash: visitor.visitorIdHash,
    });
    if (!r.ok) {
      return jsonResponse(
        { ok: false, error: { kind: "BadRequest", message: r.reason } },
        { status: 400 },
      );
    }
    return jsonResponse({ ok: true, data: { variant: r.variant } });
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

  // 2. Resolve signed visitor cookie.
  const visitor = await resolveVisitor(req, settings.cookieSecret);
  const localeHeader = req.headers.get("accept-language") ?? "en";
  const locale = localeHeader.split(",")[0]?.split(";")[0]?.split("-")[0] ?? "en";

  const cookies: string[] = [];
  if (visitor.isFresh) {
    const signed = await signCookieValue({
      value: visitor.visitorId,
      secret: settings.cookieSecret,
    });
    cookies.push(visitorCookieHeader(signed));
  }

  // P13 audit re-pass — derive an IP-scoped key once. Used on:
  //   (a) the honeypot branch (so bots can't inflate rate_limit_buckets
  //       by spinning fresh uuids — the IP pins the bucket),
  //   (b) any request from a "fresh" visitor (no signed cookie), so a
  //       single IP can't bypass throttling by rotating cookies.
  // Real users with a signed visitor cookie revert to the per-visitor
  // key (fairer rate budgets when many users share an IP via NAT).
  const ipHash = clientIpHash(req);
  const visitorRateKey = visitor.isFresh
    ? ipScopedRateLimitKey(slug, operationName, ipHash)
    : rateLimitKey(slug, operationName, visitor.visitorId);

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

  // 4. Rate limit.
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
    visitorContext: {
      visitorId: visitor.visitorId,
      locale,
      sessionToken: visitor.sessionToken,
      sessionMutation,
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
  if (!ADMIN_URL || !PUBLIC_URL) {
    throw new Error("ADMIN_DATABASE_URL + PUBLIC_DATABASE_URL must be set");
  }
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
  });
  const registry = new OperationRegistry();
  setGatewayAdapter(adapter);
  setGatewayRegistry(registry);
  // P13 audit re-pass — dedicated long-lived LISTEN connection.
  // Pooled handles return to the pool after each query, dropping any
  // pg_notify subscriptions; so we open a SEPARATE Bun.SQL client that
  // stays open for the gateway's lifetime, runs LISTEN, and yields a
  // streaming iterable of notifications. The 5s TTL is the safety net
  // when this fails (e.g. during DB restart) so we don't block boot.
  void (async () => {
    try {
      const listenSql = new SQL(ADMIN_URL);
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
  await bootstrapPluginHost({
    infra: { adapter, registry },
    pluginsRoot: PLUGINS_ROOT,
    systemActorId: SYSTEM_ACTOR_ID,
  });
  const server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
  });
  // biome-ignore lint/suspicious/noConsole: startup banner
  console.log(`[api-gateway] listening on :${server.port}`);
}
