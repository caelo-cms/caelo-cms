// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo API gateway — public-facing HTTP entry point for plugin operations.
 *
 * Routes:
 *   POST /api/plugin/<slug>/<operation>     JSON body → JSON response
 *   GET  /api/_caelo/mail-link/<slug>/<op>  confirmation page of a mail link
 *   POST /api/_caelo/mail-link/<slug>/<op>  one-click unsubscribe (RFC 8058)
 *   GET  /api/captcha/challenge             PoW challenge envelope
 *   GET  /healthz                           liveness probe
 *   GET  /api/_caelo/health[?deep=1]        upgrade health check (health.ts)
 *
 * The staging gateway (`CAELO_GATEWAY_ENVIRONMENT=staging`, #1330) puts the
 * #650 gate in front of every route but `/healthz`, on every host, and
 * serves the staged site itself (staging/site.ts); admitted `/api/*`
 * requests take the routes above against its own database.
 *
 * While its feature is off it answers the fixed 404 of an unknown path
 * before it reads anything of the request and before any database access
 * (epic #763 E14 a, {@link featureOff}): the live gateway while no active
 * plugin serves an operation to visitors, the staging gateway while no
 * staging host is set. Every install provisions both at zero minimum
 * instances, so an off gateway costs nothing and exposes nothing but
 * `/healthz` and the upgrade's health check.
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
 *   2. Resolve the signed visitor id + signed login session (HMAC-SHA256),
 *      both entries of the one `__session` cookie — the only cookie
 *      Firebase Hosting forwards, used on every provider (#1343,
 *      gateway-cookies.ts). The visitor id exists only when an active
 *      plugin declares the `visitor_id` consent purpose and the decision
 *      in the request's `x-caelo-consent` header grants its category
 *      (#677, visitor.ts): otherwise no id, and any id the browser still
 *      holds is removed. Tampered → a fresh id (consented).
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
 *
 * The gateway runs on request-billed CPU (#1141, #1361): it does nothing
 * between requests, and a request that starts after an idle stretch
 * confirms the published state it caches before it answers from it
 * (published-changes.ts), because a publish notification may still wait in
 * the socket.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  bootstrapDispatchOnly,
  ensureDevSignedManifests,
  hostInfra,
  loadedPlugins,
  markDispatchRegistryStale,
  pluginDeclaresConsentPurpose,
  registerGatewayOperations,
  runPluginOperation,
  servesVisitorOperations,
  syncDispatchPlugins,
  unpublishedRegistryError,
  VISITOR_ID_PURPOSE,
  verifyMailUnsubscribeToken,
} from "@caelo-cms/plugin-host";
import { publicOperationOf } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry, type TransactionRunner } from "@caelo-cms/query-api";
import { SESSION_ENTRY } from "@caelo-cms/shared";
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
  GATEWAY_ENVIRONMENTS,
  gatewayDatabaseRoles,
  gatewayDatabaseUrls,
} from "./database-env.js";
import { gatewayStateGc } from "./gc.js";
import { GATEWAY_HEALTH_PATH, gatewayHealth } from "./health.js";
import { type IpHashKeys, ipHashKeys } from "./ip-hash-key.js";
import {
  isOneClickBody,
  MAIL_ONE_CLICK_MAX_BYTES,
  mailLinkOf,
  mailLinkPage,
  parseMailLinkPath,
} from "./mail-link.js";
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
import { GATEWAY_PLUGINS_ROOT } from "./plugins-root.js";
import {
  confirmOffAnswer,
  confirmPublishedState,
  listenForPublishedChanges,
  mayCacheRead,
  onPublishedChange,
  publishedCacheGeneration,
  publishedCacheUsable,
  servePublishedRequest,
} from "./published-changes.js";
import {
  gateFailureLimiter,
  handleStagingSiteRequest,
  ManifestCache,
  type PublishedRedirects,
  type StagingSiteState,
} from "./staging/site.js";
import { type StagingStorage, stagingStorageFromEnv } from "./staging/storage.js";
import {
  ANONYMOUS_VISITOR_ACTOR,
  invalidateVisitorConsentRule,
  loadVisitorConsentRule,
  type ResolvedVisitor,
  resolveVisitor,
  visitorIdDeclared,
} from "./visitor.js";

export {
  GATEWAY_DATABASE_ENV,
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
} from "./database-env.js";
export { parseCookies } from "./visitor.js";

const SYSTEM_ACTOR_ID = process.env.CAELO_SYSTEM_ACTOR_ID ?? "00000000-0000-0000-0000-00000000ffff";
// Cloud Run sets PORT=8080 on every container; read that first so a
// platform deploy needs no extra config. GATEWAY_PORT is the historical
// name retained for self-hosted Compose installs.
const PORT = Number.parseInt(process.env.PORT ?? process.env.GATEWAY_PORT ?? "8090", 10);
const PLUGINS_ROOT = GATEWAY_PLUGINS_ROOT;

const SYSTEM_CTX = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "gateway",
};

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
  /** #1432 — the admin's published key for unsubscribe links; null before it published one. */
  mailLinkKey: string | null;
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
             live_origins, mail_link_key
      FROM published_gateway_settings WHERE id = 1
    `)) as unknown as {
      cookie_secret: string | null;
      max_body_bytes: number;
      captcha_provider: "off" | "pow" | "turnstile" | "hcaptcha";
      captcha_pow_target_prefix: string;
      live_origins: string[] | null;
      mail_link_key: string | null;
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
    mailLinkKey: row.mail_link_key,
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

/**
 * #1361 — the projection's section versions as one string: every publish
 * rewrites the rows of the sections it published (a new `xmin`) in the
 * transaction that notifies, and removes a section it unpublishes, so two
 * equal strings mean no publish committed in between
 * (published-changes.ts `servePublishedRequest`).
 */
async function readProjectionVersions(adapter: DatabaseAdapter): Promise<string> {
  const rows = (await adapter.withPublicTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`
        SELECT coalesce(string_agg(section || ':' || xmin::text, ',' ORDER BY section), '') AS v
        FROM published_projection_sections
      `),
  )) as unknown as { v: string }[];
  return rows[0]?.v ?? "";
}

/** {@link confirmPublishedState} against this gateway's own projection. */
function confirmPublishedStateOn(adapter: DatabaseAdapter): Promise<void> {
  return confirmPublishedState(() => readProjectionVersions(adapter));
}

/** {@link confirmOffAnswer} against this gateway's own projection. */
function confirmOffAnswerOn(adapter: DatabaseAdapter): Promise<void> {
  return confirmOffAnswer(() => readProjectionVersions(adapter));
}

export function invalidateGatewaySettings(): void {
  cachedSettings = null;
  cachedStagingState = null;
  cachedRedirects = null;
  visitorApiOff = null;
  markDispatchRegistryStale();
  invalidateVisitorConsentRule();
}

// ---------------------------------------------------------------------------
// Epic #763 E14 a — a gateway whose feature is off answers the fixed 404.
// ---------------------------------------------------------------------------

/**
 * Whether no active plugin serves an operation to visitors, as of the last
 * registry sync made since the admin's last publish notification; null when
 * that is not known. Dropped with every other published-state cache.
 */
let visitorApiOff: boolean | null = null;

/**
 * Learn whether the visitor API is off: one registry sync (a read of the
 * projection), cached until the next publish notification. A sync that
 * failed or was overtaken by a notification leaves it unknown, and the
 * request takes the full pipeline (which answers the registry's own 503).
 *
 * #1361 — while the answer is unknown (after a notification, at boot) this
 * reads the database before the request is read (E14 a), so it confirms the
 * published state first: otherwise the confirmation after the cheap gates
 * would drop what it learns here.
 */
async function learnVisitorApiOff(adapter: DatabaseAdapter): Promise<boolean> {
  if (visitorApiOff === null) await confirmPublishedStateOn(adapter);
  const startedAt = publishedCacheGeneration();
  await syncDispatchPlugins();
  const serves = servesVisitorOperations();
  if (serves === null) return false;
  if (mayCacheRead(startedAt)) visitorApiOff = !serves;
  return !serves;
}

/**
 * Whether this gateway's feature is known to be off without touching the
 * database: the cached answer, valid only while the published-state LISTEN
 * holds (published-changes.ts). The staging gateway's own feature (a
 * staging host) is checked on its state in {@link stagingRequest}; its
 * `/api/*` follows the staging registry like the live one.
 */
function featureOff(): boolean {
  return visitorApiOff === true && publishedCacheUsable();
}

// ---------------------------------------------------------------------------
// The staging site (#1330) — what the staging gateway serves, as the admin
// published it into cms_public_staging (`published_staging_site`): the gate,
// its key and the served build; and the redirects table. Cached and
// invalidated like the settings above (the admin notifies on every change
// and every Stage).
// ---------------------------------------------------------------------------

let cachedStagingState: StagingSiteState | null = null;
let cachedRedirects: PublishedRedirects | null = null;

async function loadStagingSiteState(adapter: DatabaseAdapter): Promise<StagingSiteState> {
  if (cachedStagingState && publishedCacheUsable()) return cachedStagingState;
  const startedAt = publishedCacheGeneration();
  const rows = (await adapter.withPublicTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`
        SELECT staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce,
               header_enabled, header_name, header_nonce, ip_allowlist, gate_secret,
               served_run_id::text AS served_run_id, served_location, build_origin
        FROM published_staging_site WHERE id = 1
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
    gate_secret: string | null;
    served_run_id: string | null;
    served_location: string | null;
    build_origin: string | null;
  }[];
  const row = rows[0];
  if (!row) {
    throw new GatewayNotReadyError(
      "the admin has not published the staging site yet (published_staging_site); start the admin once, it publishes it",
    );
  }
  const state: StagingSiteState = {
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
    gateSecret: row.gate_secret,
    served:
      row.served_run_id && row.served_location
        ? { runId: row.served_run_id, location: row.served_location, buildOrigin: row.build_origin }
        : null,
  };
  if (mayCacheRead(startedAt)) cachedStagingState = state;
  return state;
}

/**
 * #1550 — the live rows and the shared draft's Staged changes, read in ONE
 * statement: under READ COMMITTED each statement takes its own snapshot,
 * so two reads could straddle a projection commit and pair the live rows of
 * one publish with the changes of the next (a loop neither of them has).
 */
async function loadPublishedRedirects(adapter: DatabaseAdapter): Promise<PublishedRedirects> {
  if (cachedRedirects && publishedCacheUsable()) return cachedRedirects;
  const startedAt = publishedCacheGeneration();
  const rows = (await adapter.withPublicTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`
        SELECT 'live' AS kind, NULL::text AS id, NULL::text AS address, from_path, to_path,
               status_code, NULL::boolean AS automatic, from_path AS sort_key
        FROM published_redirects
        UNION ALL
        SELECT 'staged', id::text, address, from_path, to_path, status_code, automatic,
               address
        FROM published_redirect_changes
        ORDER BY kind, sort_key
      `),
  )) as unknown as {
    kind: "live" | "staged";
    id: string | null;
    address: string | null;
    from_path: string;
    to_path: string | null;
    status_code: number | null;
    automatic: boolean | null;
  }[];
  const live: PublishedRedirects["live"][number][] = [];
  const staged: PublishedRedirects["staged"][number][] = [];
  for (const r of rows) {
    if (r.kind === "live") {
      if (r.to_path === null || r.status_code === null) {
        throw new Error(`published_redirects: the row for ${r.from_path} has no target`);
      }
      live.push({ fromPath: r.from_path, toPath: r.to_path, statusCode: r.status_code });
    } else {
      if (r.id === null || r.address === null || r.automatic === null) {
        throw new Error(`published_redirect_changes: the change for ${r.from_path} is incomplete`);
      }
      staged.push({
        id: r.id,
        address: r.address,
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
        automatic: r.automatic,
      });
    }
  }
  const redirects: PublishedRedirects = { live, staged };
  if (mayCacheRead(startedAt)) cachedRedirects = redirects;
  return redirects;
}

/** The staging gateway's serving parts (#1330); null on the live gateway. */
interface StagingSiteRuntime {
  readonly storage: StagingStorage;
  readonly manifests: ManifestCache;
  readonly failures: ReturnType<typeof gateFailureLimiter>;
}
let stagingSite: StagingSiteRuntime | null = null;

/**
 * Make this gateway the staging gateway (#1330): every request but
 * `/healthz` passes the gate, and the staged site is served from `storage`.
 * Called at boot for `CAELO_GATEWAY_ENVIRONMENT=staging`; tests call it
 * directly, and with `null` to go back to the live gateway.
 */
export function setStagingSite(storage: StagingStorage | null): void {
  stagingSite = storage
    ? { storage, manifests: new ManifestCache(), failures: gateFailureLimiter() }
    : null;
  cachedStagingState = null;
  cachedRedirects = null;
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
 * What the plugin host needs to check an unsubscribe link here: the key as
 * the admin published it. No origin, because a gateway never makes a link.
 */
export async function gatewayMailLinks(): Promise<{ origin: null; key: string | null }> {
  if (!cachedAdapter) throw new Error("gateway not bootstrapped");
  return { origin: null, key: (await loadSettings(cachedAdapter)).mailLinkKey };
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
 * hard ceiling (#1328 moved the remote-MCP proxy and its larger image
 * uploads to the MCP-Auth-Proxy). Each route still enforces its own cap;
 * this one stops a body nobody would read before it is buffered (Bun's
 * default is 128 MB).
 */
export const SERVER_MAX_REQUEST_BODY_BYTES = HARD_MAX_BODY_BYTES;

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
}

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
  // the staging proxy builds itself.
  const requestId = crypto.randomUUID();
  try {
    // #1361 — counted in flight: a request that starts on an idle instance
    // marks the published state unconfirmed (published-changes.ts).
    const response = await servePublishedRequest(() => routeRequest(req, conn, requestId));
    return withJsonSecurityHeaders(response);
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

  if (stagingSite && url.pathname !== "/healthz") {
    return stagingRequest(req, conn, requestId, stagingSite);
  }
  return visitorRequest(req, conn, requestId);
}

/**
 * One request on the staging gateway (#1330, staging/site.ts): the gate on
 * every host, then the staged site or, for `/api/*`, the visitor routes on
 * this gateway's own database.
 */
async function stagingRequest(
  req: Request,
  conn: GatewayConnection,
  requestId: string,
  site: StagingSiteRuntime,
): Promise<Response> {
  if (!cachedAdapter) {
    return errorResponse("ServiceUnavailable", 503, requestId, { log: "gateway not bootstrapped" });
  }
  const adapter = cachedAdapter;
  const unavailable = (e: unknown): Response => {
    console.error(
      `[api-gateway] request ${requestId}: staging site unavailable — ${describeFailure(e)}`,
    );
    return new Response("Staging is unavailable. Try again in a moment.", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "X-Request-Id": requestId,
      },
    });
  };
  // The published state first: E14 a — with no staging host set the staging
  // site is off, the fixed 404 before anything of the request is read (from
  // memory while the LISTEN holds, else one read of the projection row).
  // #1361 — an answer from memory is confirmed at most once per
  // CONFIRM_MAX_AGE_MS: a staging host set while this instance idled is
  // served from its first request after that.
  let state: StagingSiteState;
  try {
    state = await loadStagingSiteState(adapter);
    if (state.host === null) {
      await confirmOffAnswerOn(adapter);
      state = await loadStagingSiteState(adapter);
    }
  } catch (e) {
    return unavailable(e);
  }
  if (state.host === null) return errorResponse("NotFound", 404, requestId);
  // The allowlist and the failure budget match the address the rate limits bucket by.
  const client = requestClientAddress(req, conn, requestId);
  if (!client.ok) return client.response;
  const clientKey = rateLimitAddress(client.value);
  // #1361 — the gate decides on published state: confirm it first, after the
  // per-client failure budget (a client that used it up gets its 429 from
  // memory), and take the state again in case a publish dropped it.
  if (site.failures.peek(clientKey).allowed) {
    try {
      await confirmPublishedStateOn(adapter);
      state = await loadStagingSiteState(adapter);
    } catch (e) {
      return unavailable(e);
    }
    if (state.host === null) return errorResponse("NotFound", 404, requestId);
  }
  return handleStagingSiteRequest(req, {
    state,
    clientIp: client.value,
    clientKey,
    provider: process.env.CAELO_PROVIDER,
    storage: site.storage,
    manifests: site.manifests,
    redirects: () => loadPublishedRedirects(adapter),
    failures: site.failures,
    api: (admitted) => visitorRequest(admitted, conn, requestId),
    secure: process.env.NODE_ENV === "production",
  });
}

/** The visitor routes (both gateways; on staging only after the gate). */
async function visitorRequest(
  req: Request,
  conn: GatewayConnection,
  requestId: string,
): Promise<Response> {
  const url = new URL(req.url);
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

  // ---- E14 a: no visitor plugin active, the fixed 404 before anything of
  // the request is read. Known from memory while the LISTEN holds, that
  // answer confirmed at most once per CONFIRM_MAX_AGE_MS (#1361: a plugin
  // activated while this instance idled); not known yet (the first request
  // after a publish or boot, or the LISTEN is down): one registry read
  // decides, shared by concurrent requests and at most one per
  // SYNC_TTL_MS (plugin-host syncDispatchPlugins). ----
  if (featureOff() && cachedAdapter) await confirmOffAnswerOn(cachedAdapter);
  if (featureOff()) return errorResponse("NotFound", 404, requestId);
  if (cachedAdapter && (await learnVisitorApiOff(cachedAdapter))) {
    return errorResponse("NotFound", 404, requestId);
  }

  // #1337 — the confirmation page of a plugin's mail link: fixed per
  // declared link (the registry sync reads, nothing is written); the
  // click's POST is an ordinary plugin call below.
  const mailLink = req.method === "GET" ? parseMailLinkPath(url.pathname) : null;
  if (mailLink) {
    const address = requestClientAddress(req, conn, requestId);
    if (!address.ok) return address.response;
    const limited = memoryRateLimited(address.value, requestId);
    if (limited) return limited;
    if (cachedAdapter) await confirmPublishedStateOn(cachedAdapter);
    await syncDispatchPlugins();
    const link = mailLinkOf(loadedPlugins.bySlug(mailLink.slug)?.definition, mailLink.operation);
    if (!link) return errorResponse("NotFound", 404, requestId);
    return mailLinkPage(mailLink, link, requestId);
  }

  // ---- #1326: the input filter, before any database access ----
  const isCaptchaChallenge = req.method === "GET" && url.pathname === "/api/captcha/challenge";
  const pluginRoute = req.method === "POST" ? parsePluginPath(url.pathname) : null;
  const oneClick = req.method === "POST" ? parseMailLinkPath(url.pathname) : null;
  if (!isCaptchaChallenge && !pluginRoute && !oneClick) {
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
  // #1361 — the cheap gates above passed: confirm the published state the
  // rest answers from (settings, registry, rate-limit specs, consent rule).
  await confirmPublishedStateOn(adapter);
  if (oneClick) return mailOneClick(req, url, oneClick, requestId);
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

/** How long a `Busy` (503) answer asks the client to wait (#1334). */
const BUSY_RETRY_AFTER_SEC = 2;

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
      setCookies: visitor.cookies.setCookieHeaders(),
      retryAfterSec: challengeRl.retryAfterSec,
    });
  }
  const challenge = await issuePowChallenge(adapter, { config: settings.captcha });
  return jsonResponse(
    { ok: true, data: challenge },
    { setCookies: visitor.cookies.setCookieHeaders() },
  );
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
    publicOperationOf(plugin.definition.publicOperations, operation) !== undefined;
  return served ? "served" : "unknown";
}

/**
 * The HTTP status of a refused plugin operation. The kind says who refused
 * and why; the detail stays in the log.
 */
function pluginErrorStatus(kind: string): number {
  switch (kind) {
    case "PluginNotFound":
    // A caller probing for an admin-only operation learns only that this
    // path serves nothing: the 404 does not confirm the operation exists.
    case "OperationNotPublic":
      return 404;
    case "PluginDisabled":
    case "ProjectionNotPublished":
    // #1334 — at a bound the operation guards (concurrent password hashes):
    // a cheap 503, retried shortly.
    case "Busy":
      return 503;
    case "OperationNotDeclared":
    // #1332 — refused by the operation's declared contract, or by the
    // plugin; the detail (Zod issues, the plugin's words) stays in the log
    // like every other error (#1346).
    case "InvalidInput":
      return 400;
    case "CaptchaRequired":
      return 403;
    case "Rejected":
      return 422;
    default:
      return 500;
  }
}

/**
 * `POST /api/_caelo/mail-link/<slug>/<operation>`: a mail client's one-click
 * unsubscribe (RFC 8058, mail-link.ts). A signed token stands where a
 * browser call has its Origin and proof-of-work, so it is checked before
 * anything is written, and junk costs one key read behind the per-client
 * limiter. The budget is per recipient, not per address: a mailbox provider
 * posts for all its users from few addresses, and one recipient's token
 * cannot exhaust another's. No cookie is read or set.
 */
async function mailOneClick(
  req: Request,
  url: URL,
  route: { readonly slug: string; readonly operation: string },
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  const { slug, operation } = route;
  const served = await servedToVisitors(slug, operation);
  if (served === "unpublished") {
    return errorResponse("ProjectionNotPublished", 503, requestId, {
      log: unpublishedRegistryError()?.message ?? "plugin registry not published",
    });
  }
  const plugin = loadedPlugins.bySlug(slug);
  if (
    served === "unknown" ||
    !plugin ||
    plugin.definition.mailUnsubscribe?.operation !== operation
  ) {
    return errorResponse("NotFound", 404, requestId);
  }
  const opLimited = operationRateLimited(`${slug}.${operation}`, requestId);
  if (opLimited) return opLimited;
  await sweepGatewayStateIfDue?.();

  const start = performance.now();
  const logRow = (
    row: Omit<
      RequestLogRow,
      | "pluginSlug"
      | "operation"
      | "durationMs"
      | "bodyBytes"
      | "wasHoneypotCaught"
      | "captchaPassed"
    >,
    bodyBytes: number,
  ) =>
    recordRequest({
      pluginSlug: slug,
      operation,
      durationMs: Math.round(performance.now() - start),
      bodyBytes,
      wasHoneypotCaught: false,
      captchaPassed: false,
      ...row,
    });

  const cap = await readBodyWithCap(req, MAIL_ONE_CLICK_MAX_BYTES);
  if (!cap.ok) return errorResponse("PayloadTooLarge", 413, requestId);
  if (!(await isOneClickBody(req.headers.get("content-type"), cap.body))) {
    return errorResponse("BadRequest", 400, requestId);
  }
  const token = url.searchParams.get("token");
  if (!(await verifyMailUnsubscribeToken(plugin, hostInfra(), token))) {
    await logRow({ statusCode: 404, wasRateLimited: false, errorKind: "NotFound" }, cap.bytes);
    return errorResponse("NotFound", 404, requestId);
  }

  const spec = await resolveRateLimitSpec(adapter, slug, operation, plugin);
  const rl = await consumeRateLimit(adapter, {
    key: `gateway-mail-one-click:${slug}:${operation}:${createHash("sha256")
      .update(token as string)
      .digest("hex")}`,
    spec,
  });
  if (!rl.allowed) {
    await logRow({ statusCode: 429, wasRateLimited: true, errorKind: "RateLimited" }, cap.bytes);
    return errorResponse("RateLimited", 429, requestId, { retryAfterSec: rl.retryAfterSec });
  }

  const result = await runPluginOperation({
    pluginSlug: slug,
    operationName: operation,
    args: { token },
    invocation: { origin: "visitor", actorId: ANONYMOUS_VISITOR_ACTOR },
    visitorContext: {
      visitorId: null,
      sessionToken: null,
      captcha: { enforced: true, proofVerified: false },
      mailOneClick: true,
    },
  });
  if (!result.ok) {
    const status = pluginErrorStatus(result.error.kind);
    await logRow(
      { statusCode: status, wasRateLimited: false, errorKind: result.error.kind },
      cap.bytes,
    );
    return errorResponse(result.error.kind, status, requestId, {
      log: `${slug}.${operation}: ${result.error.message ?? "no message"}`,
      ...(result.error.kind === "Busy" ? { retryAfterSec: BUSY_RETRY_AFTER_SEC } : {}),
    });
  }
  await logRow({ statusCode: 200, wasRateLimited: false }, cap.bytes);
  return jsonResponse({ ok: true });
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
  // The `__session` container; each response below stores what changed.
  const { cookies } = visitor;

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
      setCookies: cookies.setCookieHeaders(),
      retryAfterSec: rl.retryAfterSec,
    });
  }

  // 5. Captcha verify (when caller supplied one + provider is PoW).
  let captchaPassed = false;
  if (settings.captcha.provider === "pow") {
    const proof = (body as { _caelo_captcha?: { challenge: string; nonce: string } })
      ._caelo_captcha;
    if (proof) {
      // #1332 — a proof is valid only for the operation it was solved for.
      const verify = await verifyPowProof(adapter, proof, `${slug}.${operationName}`);
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
          setCookies: cookies.setCookieHeaders(),
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
    const expiresAt = new Date(sessionMutation.current.expiresAt).getTime() / 1000;
    const signed = await signCookieValue({
      value: sessionMutation.current.sessionToken,
      secret: settings.cookieSecret,
    });
    cookies.setLogin(signed, expiresAt);
  } else if (sessionMutation.current.kind === "clear") {
    cookies.remove(SESSION_ENTRY.login);
  }

  if (!result.ok) {
    const status = pluginErrorStatus(result.error.kind);
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
      setCookies: cookies.setCookieHeaders(),
      log: `${slug}.${operationName}: ${result.error.message ?? "no message"}`,
      ...(result.error.kind === "Busy" ? { retryAfterSec: BUSY_RETRY_AFTER_SEC } : {}),
    });
  }
  await logRow(
    { statusCode: 200, wasRateLimited: false, wasHoneypotCaught: false, captchaPassed },
    cap.bytes,
  );
  return jsonResponse({ ok: true, data: result.value }, { setCookies: cookies.setCookieHeaders() });
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
  console.log(`[api-gateway] environment: ${urls.environment}`);
  // No cms_admin pool at all (#635): every path that would reach the
  // authoring database throws AdminDatabaseUnavailableError. verifyRoles
  // fails loudly if the URL resolves to anything but the environment's own
  // login on its own database (#1329).
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    publicDatabase: GATEWAY_ENVIRONMENTS[urls.environment].database,
    expectedRoles: gatewayDatabaseRoles(urls.environment),
  });
  // Ask the database too (#635, #1329): a login that can reach cms_admin or
  // the other environment's database, or a bridge out of its own, is
  // refused before the first request.
  await adapter.verifyRoles();
  const isolation = await databaseIsolationProblems(adapter.rawPublic(), urls.environment);
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
  // #1330 — the staging gateway serves the staged site from staging storage,
  // behind the gate; the live gateway has none.
  if (urls.environment === "staging") {
    const storage = stagingStorageFromEnv(process.env);
    setStagingSite(storage);
    console.log(`[api-gateway] serving the staged site from ${storage.describe}, behind the gate`);
  }
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
    infra: { adapter, registry, mailLinks: gatewayMailLinks },
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
      }),
  });
  console.log(`[api-gateway] listening on :${server.port}`);
}
