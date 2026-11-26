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
import {
  bootstrapDispatchOnly,
  hostInfra,
  loadedPlugins,
  markDispatchRegistryStale,
  pluginDeclaresConsentPurpose,
  registerGatewayOperations,
  runPluginOperation,
  servesVisitorOperations,
  setPublishedVisitorConfigReader,
  syncDispatchPlugins,
  unpublishedRegistryError,
  VISITOR_ID_PURPOSE,
  verifyMailUnsubscribeToken,
} from "@caelo-cms/plugin-host/gateway";
import { publicOperationOf } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry, type TransactionRunner } from "@caelo-cms/query-api";
import {
  GATEWAY_REFRESH_ACCOUNT_ENV,
  GATEWAY_REFRESH_PATH,
  GATEWAY_REFRESH_TOKEN_HEADER,
  gatewayRefreshAudience,
  gatewayRefreshPingsOn,
  SESSION_ENTRY,
  visitorAiStreamOrigin,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  ClientAddressError,
  clientAddress,
  hashClientAddress,
  rateLimitAddress,
  trustedProxyHopsFromEnv,
} from "./client-ip.js";
import {
  declaredCollectionOperation,
  declaredCollectionOperations,
  defaultQueryEmbedder,
  GatewayCollections,
  parseCollectionPath,
  runCollectionOperation,
  settlesWithin,
} from "./collections.js";
import {
  databaseIsolationProblems,
  GATEWAY_ENVIRONMENT_DATABASES,
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
  COLLECTION_CLIENT_MEMORY_LIMIT,
  COLLECTION_OPERATION_MEMORY_LIMIT,
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
  confirmPublishedState,
  dropPublishedState,
  listenForPublishedChanges,
  mayCacheRead,
  onPublishedChange,
  publishedCacheGeneration,
  publishedCacheUsable,
  servePublishedRequest,
} from "./published-changes.js";
import { createRefreshPingVerifier, type RefreshPingVerifier } from "./refresh-ping.js";
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
import {
  aiChatAvailable,
  aiChatPreflight,
  aiChatRefusal,
  aiChatResponse,
} from "./visitor-ai/chat.js";
import { loadVisitorConfig } from "./visitor-ai/published.js";
import {
  collectionToolRuntime,
  declaredAiChatOperation,
  resolveAiChatTools,
} from "./visitor-ai/route.js";

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
// The admin's refresh ping (@caelo-cms/shared gateway-refresh.ts). On
// request-billed CPU a publish notification that arrives while this
// instance idles waits in its socket, and an off gateway answers visitors
// from memory without ever asking the database. So after every publish that
// wrote this gateway's database the admin sends it one request, and that
// request reads the published state again.
// ---------------------------------------------------------------------------

/** The check of the admin's pings; null when this gateway takes none. */
let refreshPingVerifier: RefreshPingVerifier | null = null;

/** Configure (or, with null, switch off) the check of the admin's pings. Called once at boot; tests. */
export function setRefreshPingVerifier(verifier: RefreshPingVerifier | null): void {
  refreshPingVerifier = verifier;
}

/** A refresh in flight, joined by pings that arrive while it runs. */
let refreshing: Promise<void> | null = null;

/** How often a refresh reads again when a notification dropped what it read. */
const REFRESH_ROUNDS = 2;

/**
 * Drop every cache of published state, as a notification does, and read
 * again, on this request's CPU, what decides this gateway's answers: the
 * visitor API's registry and, on the staging gateway, the staging site. The
 * visitors after the ping are answered from memory again (E14 a).
 *
 * The notification of the same publish may be handled while this reads (it
 * arrived first and waited in the socket): it drops what the read was about
 * to cache, and the refresh reads once more.
 *
 * @throws when it could not learn that state — the registry sync failed or
 *   an active plugin could not be attached (the plugin host logs and
 *   swallows both), or the staging site could not be read — so the ping
 *   answers 503 and the admin records a miss, never a success.
 */
function refreshPublishedState(adapter: DatabaseAdapter): Promise<void> {
  if (refreshing) return refreshing;
  const run = (async () => {
    // Nothing is cached while the LISTEN is down: every request reads through.
    if (!publishedCacheUsable()) return;
    let missing: string | null = null;
    for (let round = 0; round < REFRESH_ROUNDS; round += 1) {
      dropPublishedState();
      await learnVisitorApiOff(adapter);
      if (stagingSite) await loadStagingSiteState(adapter);
      missing =
        visitorApiOff === null
          ? "the plugin registry (this gateway's plugin-host log says why)"
          : stagingSite && cachedStagingState === null
            ? "the staging site"
            : null;
      if (missing === null) return;
    }
    throw new Error(`could not learn ${missing} in ${REFRESH_ROUNDS} reads`);
  })().finally(() => {
    if (refreshing === run) refreshing = null;
  });
  refreshing = run;
  return run;
}

/**
 * `POST` {@link GATEWAY_REFRESH_PATH}: the admin's ping. Anything but a ping
 * this gateway can verify — no check configured, another method, a missing
 * or invalid token — gets the fixed 404 of an unknown path, without the
 * database and without reading more of the request (E14 a).
 */
async function refreshPingRequest(req: Request, requestId: string): Promise<Response> {
  const verifier = refreshPingVerifier;
  if (req.method !== "POST" || verifier === null || cachedAdapter === null) {
    return errorResponse("NotFound", 404, requestId);
  }
  const verdict = await verifier(req.headers.get(GATEWAY_REFRESH_TOKEN_HEADER));
  if (!verdict.ok) return errorResponse("NotFound", 404, requestId);
  try {
    await refreshPublishedState(cachedAdapter);
  } catch (e) {
    return errorResponse("ServiceUnavailable", 503, requestId, {
      log: `refresh ping: could not read the published state — ${describeFailure(e)}`,
    });
  }
  await warmPublishedCollections(cachedAdapter, requestId);
  return jsonResponse({ ok: true }, { requestId });
}

/**
 * How long the refresh ping spends opening newly published collection
 * releases. The admin waits for the ping (admin-core gateway-refresh.ts:
 * 10 s, a cold start included), so the ping loads only the index files,
 * never the query model: that load is seconds of CPU, and the first
 * visitor's `/release` does it.
 */
export const REFRESH_WARM_WAIT_MS = 4_000;

/**
 * After a publish: open the releases the active plugins' declared
 * operations now answer from and load their index files, inside the
 * admin's ping, so the first visitor search after a Publish live does not
 * read them one by one. Bounded by {@link REFRESH_WARM_WAIT_MS}; a failure is
 * logged and never fails the ping (the publish it reports has committed).
 */
async function warmPublishedCollections(
  adapter: DatabaseAdapter,
  requestId: string,
): Promise<void> {
  try {
    await syncDispatchPlugins();
    const declared = declaredCollectionOperations();
    if (declared.length === 0) return;
    const collections = collectionsOfGateway();
    const startedAt = publishedCacheGeneration();
    const keys = await collections.releaseKeys(adapter, SYSTEM_CTX, () => mayCacheRead(startedAt));
    const warmed = await settlesWithin(
      Promise.all(declared.map((d) => collections.warmOperation(d, keys))),
      REFRESH_WARM_WAIT_MS,
    );
    if (!warmed) {
      console.warn(
        `[api-gateway] refresh ping: opening the published collections took longer than ${REFRESH_WARM_WAIT_MS} ms; the first search loads the rest (request ${requestId})`,
      );
    }
  } catch (e) {
    console.error(
      `[api-gateway] refresh ping: the published collections were not opened — ${describeFailure(e)} (request ${requestId})`,
    );
  }
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
  // #1655 — a declaration's `onlyIf: { config }` reads the released
  // visitor-visible configuration, cached like the conversations read it.
  setPublishedVisitorConfigReader((pluginId) => loadVisitorConfig(adapter, pluginId));
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

  // The admin's ping, on both gateways: before the staging gate and before
  // the off switch, checked without the database (refreshPingRequest).
  if (url.pathname === GATEWAY_REFRESH_PATH) return refreshPingRequest(req, requestId);
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
  // Visitor traffic never makes an off gateway ask the database again: a
  // host set while this instance idled reaches it with the admin's ping
  // (refreshPingRequest).
  let state: StagingSiteState;
  try {
    state = await loadStagingSiteState(adapter);
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
  // the request is read. Known from memory while the LISTEN holds; not
  // known yet (the first request after a publish or boot, or the LISTEN is
  // down): one registry read decides, shared by concurrent requests and at
  // most one per SYNC_TTL_MS (plugin-host syncDispatchPlugins). A plugin
  // activated while this instance idled reaches it with the admin's ping
  // (refreshPingRequest), never through visitor traffic. ----
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
  // #1654 — the CORS preflight of a conversation the widget runs from the
  // site's own origin against this gateway's run.app origin (gcp-firebase).
  const preflight = req.method === "OPTIONS" ? parsePluginPath(url.pathname) : null;
  const oneClick = req.method === "POST" ? parseMailLinkPath(url.pathname) : null;
  // #1649 — a declared collection operation answers a GET: cacheable, no cookie.
  const collectionRoute =
    req.method === "GET" && !isCaptchaChallenge ? parseCollectionPath(url.pathname) : null;
  if (!isCaptchaChallenge && !pluginRoute && !oneClick && !collectionRoute && !preflight) {
    return errorResponse("NotFound", 404, requestId);
  }
  const client = requestClientAddress(req, conn, requestId);
  if (!client.ok) return client.response;
  // #1649 — collection reads have their own budget (no database, cheap CPU).
  const memoryLimited = collectionRoute
    ? collectionClientRateLimited(client.value, requestId)
    : memoryRateLimited(client.value, requestId);
  if (memoryLimited) return memoryLimited;

  if (!cachedAdapter) {
    return errorResponse("ServiceUnavailable", 503, requestId, { log: "gateway not bootstrapped" });
  }
  const adapter = cachedAdapter;
  // #1361 — the cheap gates above passed: confirm the published state the
  // rest answers from (settings, registry, rate-limit specs, consent rule).
  await confirmPublishedStateOn(adapter);
  if (collectionRoute) {
    // #1654 — a declared conversation answers its GET with what the widget needs.
    await syncDispatchPlugins();
    const chat = collectionRoute.releaseOnly
      ? null
      : declaredAiChatOperation(collectionRoute.slug, collectionRoute.operation);
    if (chat) return aiChatInfoResponse(req, chat, requestId);
    return collectionOperation(url, collectionRoute, requestId);
  }
  if (oneClick) return mailOneClick(req, url, oneClick, requestId);
  let settings: GatewaySettings;
  try {
    settings = await loadSettings(adapter);
  } catch (e) {
    return settingsUnavailable(e, requestId);
  }

  if (isCaptchaChallenge) return captchaChallenge(req, url, settings, client.value, requestId);
  if (preflight) {
    await syncDispatchPlugins();
    if (!declaredAiChatOperation(preflight.slug, preflight.operation))
      return errorResponse("NotFound", 404, requestId);
    return aiChatPreflight(req, settings.liveOrigins ?? [], requestId);
  }
  if (!pluginRoute) return errorResponse("NotFound", 404, requestId);
  await syncDispatchPlugins();
  const chat = declaredAiChatOperation(pluginRoute.slug, pluginRoute.operation);
  if (chat) return aiChatOperation(req, settings, client.value, pluginRoute, chat, requestId);
  return pluginOperation(req, settings, client.value, pluginRoute, requestId);
}

let streamOrigin: Promise<string | null> | null = null;

/**
 * #1654 — where the widget streams this gateway's conversations from: its
 * run.app origin on gcp-firebase (the Firebase rewrite buffers), the
 * site's own elsewhere (shared visitor-ai-origin.ts). Learned once: a
 * service's address does not change while it runs.
 */
function ownStreamOrigin(): Promise<string | null> {
  if (!streamOrigin) {
    streamOrigin = visitorAiStreamOrigin(process.env, {
      service: process.env.K_SERVICE,
      environment: process.env.CAELO_GATEWAY_ENVIRONMENT === "staging" ? "staging" : "live",
    });
    streamOrigin.catch(() => {
      streamOrigin = null;
    });
  }
  return streamOrigin;
}

/**
 * #1654 — `GET` of a declared conversation: whether it can answer now,
 * where to stream from and the limits a widget shows. No key, budget or
 * prompt is in it; the turn itself checks everything again.
 */
async function aiChatInfoResponse(
  req: Request,
  chat: NonNullable<ReturnType<typeof declaredAiChatOperation>>,
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  let settings: GatewaySettings;
  try {
    settings = await loadSettings(adapter);
  } catch (e) {
    return settingsUnavailable(e, requestId);
  }
  let origin: string | null;
  try {
    origin = await ownStreamOrigin();
  } catch (e) {
    return errorResponse("ServiceUnavailable", 503, requestId, {
      log: `ai-chat stream origin: ${describeFailure(e)}`,
    });
  }
  const { problem: available, limits } = await aiChatAvailable(adapter, chat);
  const response = jsonResponse(
    {
      ok: true,
      data: {
        available: available === null,
        streamOrigin: origin,
        captcha: chat.op.captcha,
        // The limits the turn enforces (the Owner may lower the plugin's).
        limits: { maxTurns: limits.maxTurns, maxQuestionChars: limits.maxQuestionChars },
      },
    },
    { requestId },
  );
  if (available !== null)
    console.warn(`[api-gateway] request ${requestId}: ai-chat unavailable: ${available}`);
  const requestOrigin = req.headers.get("origin");
  if (requestOrigin !== null && (settings.liveOrigins ?? []).includes(requestOrigin)) {
    response.headers.set("Access-Control-Allow-Origin", requestOrigin);
    response.headers.set("Vary", "Origin");
    response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  return response;
}

/** This gateway's environment, which its visitor-AI key, turns and ledger belong to. */
function gatewayEnvironment(): "live" | "staging" {
  return process.env.CAELO_GATEWAY_ENVIRONMENT === "staging" ? "staging" : "live";
}

/**
 * #1654 — one turn of a declared `ai-chat` conversation, streamed
 * (visitor-ai/chat.ts). Core code only; the per-operation memory budget
 * first, nothing written but the ledger's reservation.
 */
async function aiChatOperation(
  req: Request,
  settings: GatewaySettings,
  clientIp: string,
  route: { readonly slug: string; readonly operation: string },
  chat: NonNullable<ReturnType<typeof declaredAiChatOperation>>,
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  const origins = settings.liveOrigins ?? [];
  const origin = req.headers.get("origin");
  const allowed = origin !== null && origins.includes(origin) ? origin : null;
  const take = operationMemoryLimiter.take(`${route.slug}.${route.operation}`);
  if (!take.allowed)
    return aiChatRefusal(
      "RateLimited",
      allowed,
      requestId,
      "site-wide operation budget",
      take.retryAfterSec,
    );
  const startedAt = publishedCacheGeneration();
  return aiChatResponse(req, {
    adapter,
    environment: gatewayEnvironment(),
    plugin: { pluginId: chat.pluginId, slug: route.slug, config: chat.config },
    op: chat.op,
    tools: resolveAiChatTools(chat.op),
    runtime: collectionToolRuntime(adapter, collectionsOfGateway(), () => mayCacheRead(startedAt)),
    siteOrigins: origins,
    verifyCaptcha: (proof) => verifyPowProof(adapter, proof, `${route.slug}.${route.operation}`),
    clientKey: rateLimitAddress(clientIp),
    requestId,
  });
}

// ---------------------------------------------------------------------------
// #1649 — declared collection operations: search, suggest, read.
// ---------------------------------------------------------------------------

const collectionClientLimiter = new MemoryRateLimiter(COLLECTION_CLIENT_MEMORY_LIMIT);
const collectionOperationLimiter = new MemoryRateLimiter(COLLECTION_OPERATION_MEMORY_LIMIT, 10_000);

function collectionClientRateLimited(address: string, requestId: string): Response | null {
  const take = collectionClientLimiter.take(rateLimitAddress(address));
  if (take.allowed) return null;
  return errorResponse("RateLimited", 429, requestId, { retryAfterSec: take.retryAfterSec });
}

/** This gateway's collection state; its environment decides which store it reads. */
let gatewayCollections: GatewayCollections | null = null;

function collectionsOfGateway(): GatewayCollections {
  if (!gatewayCollections) {
    gatewayCollections = new GatewayCollections(
      process.env.CAELO_GATEWAY_ENVIRONMENT === "staging" ? "staging" : "live",
    );
    onPublishedChange(() => gatewayCollections?.invalidate());
  }
  return gatewayCollections;
}

/** A JSON answer the CDN may keep for `sMaxAge` seconds (no cookie, ever). */
function cacheableJsonResponse(
  body: unknown,
  status: number,
  sMaxAge: number | null,
  requestId: string,
): Response {
  const response = jsonResponse(body, { status, requestId });
  if (sMaxAge !== null)
    response.headers.set("Cache-Control", `public, max-age=60, s-maxage=${sMaxAge}`);
  return response;
}

async function collectionOperation(
  url: URL,
  route: { readonly slug: string; readonly operation: string; readonly releaseOnly: boolean },
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  await syncDispatchPlugins();
  const declared = declaredCollectionOperation(route.slug, route.operation);
  if (!declared) {
    if (unpublishedRegistryError()) return errorResponse("ProjectionNotPublished", 503, requestId);
    return errorResponse("NotFound", 404, requestId);
  }
  const take = collectionOperationLimiter.take(`${route.slug}.${route.operation}`);
  if (!take.allowed) {
    return errorResponse("RateLimited", 429, requestId, {
      retryAfterSec: take.retryAfterSec,
      log: `site-wide search budget of ${route.slug}.${route.operation} spent on this instance`,
    });
  }
  const start = performance.now();
  const collections = collectionsOfGateway();
  const startedAt = publishedCacheGeneration();
  let answer: { status: number; body: unknown; cacheSeconds: number | null };
  try {
    const keys = await collections.releaseKeys(adapter, SYSTEM_CTX, () => mayCacheRead(startedAt));
    const key = keys.get(`${declared.pluginId}:${declared.op.collection}`);
    // #1651 — a search over link texts answers from two releases: both name
    // the answer (a cached one must not outlive either), so the release the
    // client sends back is the pair.
    const anchorsOf = declared.op.kind === "search" ? declared.op.anchors : undefined;
    const anchorKey = anchorsOf
      ? keys.get(`${declared.pluginId}:${anchorsOf.collection}`)
      : undefined;
    const identity = key && anchorKey ? `${key}+${anchorKey}` : key;
    const asked = url.searchParams.get("release");
    if (!key || !identity) {
      answer = {
        status: 503,
        body: { ok: false, error: { kind: "IndexNotReady", requestId } },
        cacheSeconds: null,
      };
    } else if (route.releaseOnly) {
      // The warm-up, inside this request. The client asks for the key when
      // the visitor focuses the search field, so the release opens, its
      // index files load and (for a search) the query model loads while
      // they type. Not after the answer: on request-billed CPU that work
      // would wait for the next request, which is the visitor's search
      // (#1745: 11 s on a cold instance). Past the bound the key goes
      // out anyway, and the search shares what is still loading.
      const warmed = await settlesWithin(
        collections.warmOperation({ slug: route.slug, ...declared }, keys, {
          ...(declared.op.kind === "search" ? { embedder: defaultQueryEmbedder() } : {}),
        }),
        RELEASE_WARM_WAIT_MS,
      );
      if (!warmed) {
        console.warn(
          `[api-gateway] collection ${route.slug}.${route.operation}: the warm-up took longer than ${RELEASE_WARM_WAIT_MS} ms; the key went out, the search waits for the rest (request ${requestId})`,
        );
      }
      answer = { status: 200, body: { release: identity }, cacheSeconds: null };
    } else if (asked !== null && asked !== identity) {
      // A newer Stage went live: the client asks again under the new key.
      answer = {
        status: 409,
        body: { ok: false, error: { kind: "ReleaseMoved", requestId }, release: identity },
        cacheSeconds: null,
      };
    } else {
      const entry = await collections.release(route.slug, declared.op.collection, key);
      // #1651 — the anchor collection of the same Stage, when the op declares one.
      const anchors =
        anchorsOf && anchorKey
          ? await collections.release(route.slug, anchorsOf.collection, anchorKey)
          : null;
      const ran = await runCollectionOperation(declared.op, entry, identity, url.searchParams, {
        embedQuery: defaultQueryEmbedder(),
        anchors,
      });
      answer = {
        ...ran,
        cacheSeconds: asked === identity && ran.status === 200 ? ran.cacheSeconds : null,
      };
    }
  } catch (e) {
    return errorResponse("ServiceUnavailable", 503, requestId, {
      log: `collection ${route.slug}.${route.operation}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  // #1649 — the search path writes nothing to the database: no request-log
  // row, so search-as-you-type, a flood or a store outage (every answer a
  // 503) never becomes write load. The platform's request metrics count the
  // answers and their latency; a server-side failure is one log line, which
  // never carries the query. A slow answer is a line too: the platform's
  // request log leaves these routes out (it would hold the queries), so
  // without it a slow first search leaves no trace.
  const took = Math.round(performance.now() - start);
  if (answer.status >= 500) {
    const kind = (answer.body as { error?: { kind?: string } }).error?.kind ?? "Error";
    console.warn(
      `[api-gateway] collection ${route.slug}.${route.operation}: ${answer.status} ${kind} after ${took} ms (request ${requestId})`,
    );
  } else if (!route.releaseOnly && took >= SLOW_COLLECTION_ANSWER_MS) {
    console.warn(
      `[api-gateway] collection ${route.slug}.${route.operation}: ${answer.status} after ${took} ms, slower than ${SLOW_COLLECTION_ANSWER_MS} ms (request ${requestId})`,
    );
  }
  return cacheableJsonResponse(answer.body, answer.status, answer.cacheSeconds, requestId);
}

/**
 * How long `/release` waits for its warm-up before it answers anyway. A
 * cold instance on Cloud Run's one vCPU needs seconds for the query model;
 * the bound keeps a stuck store from holding the visitor's request.
 */
export const RELEASE_WARM_WAIT_MS = 20_000;

/** A collection answer at least this slow writes a log line (without the query). */
export const SLOW_COLLECTION_ANSWER_MS = 2_000;

/** How long a `Busy` (503) answer asks the client to wait (#1334). */
const BUSY_RETRY_AFTER_SEC = 2;

/**
 * `GET /api/captcha/challenge`: a PoW challenge, bounded per client address.
 *
 * #1654 — `?for=<slug>.<op>` naming a declared ai-chat operation gets a
 * proof of work whatever the site's captcha setting: a conversation spends
 * money, so it always starts with one. The site's pages may fetch it from
 * another origin (the gateway's run.app origin on gcp-firebase), so an
 * allowed origin gets CORS.
 */
async function captchaChallenge(
  req: Request,
  url: URL,
  settings: GatewaySettings,
  clientIp: string,
  requestId: string,
): Promise<Response> {
  // `<slug>.<op>`, split at its one dot (no pattern over visitor input).
  const purpose = url.searchParams.get("for") ?? "";
  const dot = purpose.indexOf(".");
  let forChat = false;
  if (purpose.length <= 180 && dot > 0 && dot === purpose.lastIndexOf(".")) {
    await syncDispatchPlugins();
    forChat = declaredAiChatOperation(purpose.slice(0, dot), purpose.slice(dot + 1)) !== null;
  }
  if (forChat) {
    const response = await captchaChallengeFor(
      req,
      { provider: "pow", powTargetPrefix: settings.captcha.powTargetPrefix },
      settings,
      clientIp,
      requestId,
    );
    const origin = req.headers.get("origin");
    if (origin !== null && (settings.liveOrigins ?? []).includes(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
      response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    }
    return response;
  }
  return captchaChallengeFor(req, settings.captcha, settings, clientIp, requestId);
}

async function captchaChallengeFor(
  req: Request,
  captcha: CaptchaConfig,
  settings: GatewaySettings,
  clientIp: string,
  requestId: string,
): Promise<Response> {
  const adapter = cachedAdapter as DatabaseAdapter;
  if (captcha.provider === "off") {
    return new Response(null, { status: 204 });
  }
  if (captcha.provider !== "pow") {
    return errorResponse("NotImplemented", 501, requestId, {
      log: `captcha provider ${captcha.provider} is not wired yet`,
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
  const challenge = await issuePowChallenge(adapter, { config: captcha });
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
  // #1340 — a public operation is its declaration; there is no code to find.
  const served = publicOperationOf(plugin.definition.publicOperations, operation) !== undefined;
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
    publicDatabase: GATEWAY_ENVIRONMENT_DATABASES[urls.environment],
    names: urls.names,
    expectedRoles: gatewayDatabaseRoles(urls.environment, urls.names),
  });
  // Ask the database too (#635, #1329, #1689): a login that can reach
  // cms_admin, the other environment's database or another install's, or
  // a bridge out of its own, is refused before the first request.
  await adapter.verifyRoles();
  const isolation = await databaseIsolationProblems(
    adapter.rawPublic(),
    urls.environment,
    urls.names,
  );
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
  // The admin's refresh ping (refresh-ping.ts), taken from the admin's
  // runtime service account only. Required where the gateways run on
  // request-billed CPU; elsewhere the gateway hears every notification as
  // it arrives and takes no pings.
  const refreshAccount = process.env[GATEWAY_REFRESH_ACCOUNT_ENV]?.trim();
  const installEnv = process.env.CAELO_ENV?.trim();
  if (gatewayRefreshPingsOn(process.env.CAELO_PROVIDER) && (!refreshAccount || !installEnv)) {
    throw new Error(
      `${GATEWAY_REFRESH_ACCOUNT_ENV} and CAELO_ENV must be set on ${process.env.CAELO_PROVIDER}: without them the gateway cannot check the admin's refresh pings, and an off gateway would not see a feature switched on. Run \`cms-provision upgrade\`, which sets them.`,
    );
  }
  if (refreshAccount && installEnv) {
    setRefreshPingVerifier(
      createRefreshPingVerifier({
        account: refreshAccount,
        audience: gatewayRefreshAudience(installEnv, urls.environment),
      }),
    );
    console.log(`[api-gateway] refresh pings: taken from ${refreshAccount}`);
  } else {
    console.log(
      "[api-gateway] refresh pings: none (this gateway has CPU between requests and hears every publish notification as it arrives)",
    );
  }
  // #1340 — the gateway verifies the shipped manifests and runs none of
  // the plugins' code; in a dev checkout the admin signs the manifests it
  // generates (the gateway never imports a dist, so it signs nothing).
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
