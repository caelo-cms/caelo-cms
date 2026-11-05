// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1330 — the staging gateway: the staged site behind the #650 gate,
 * on every host it is reached by (epic #763 E8, E11).
 *
 * A gateway started with `CAELO_GATEWAY_ENVIRONMENT=staging` answers every
 * request here. In order:
 *
 *   1. `/healthz` — the only path without the gate (liveness, no data).
 *   2. `/_caelo/staging-access?t=<token>&next=<path>` — the admin's "Open
 *      staging" link: a valid, unexpired token becomes the staging entry of
 *      the `__session` cookie (12 h) and a redirect to `next`.
 *   3. A client whose gate failures used up its budget gets a 429 before any
 *      HMAC is computed (DoS only: the credentials are 192-bit, guessing
 *      them is not the threat).
 *   4. The gate (@caelo-cms/shared staging-gate.ts): the session entry,
 *      basic auth, the secret header, the IP allowlist (never on
 *      gcp-firebase, where no client address can be trusted) or a per-run
 *      token of the admin's capture and serve checks — any one satisfied. A
 *      refusal is a 401 (basic auth on) or a 403 page, and counts against the
 *      client's failure budget. The Host header plays no part: run.app, the
 *      staging host and any other name get the same gate.
 *   5. Admitted `/api/*` goes to the visitor routes, against this gateway's
 *      own database (cms_public_staging): staging forms, comments and votes
 *      never reach live data (#763 N4).
 *   6. Admitted GET/HEAD of anything else: the redirects table (published
 *      into the staging database, #1157; the live page wins), then the file
 *      from the served build's manifest, then the build's 404 page.
 *
 * Files are streamed from staging storage (staging/storage.ts). Pages and
 * other text are rendered for the live host (one build, promoted by a copy
 * at Publish live, #1003), so every absolute link to the live origin is
 * rewritten to the staging host while it streams. Every answer carries
 * `X-Robots-Tag: noindex` and `Cache-Control: private, no-store` (no shared
 * cache may keep an admitted answer for someone the gate would refuse).
 *
 * Firebase replays a GET that has not started answering after 60 s up to
 * eight times (#1325), so a file that does not start within
 * {@link FIRST_BYTE_BUDGET_MS} is answered with a 504.
 */

import {
  buildRedirectPlan,
  decideStagingAccess,
  goneStatusOnProvider,
  isHtmlContentType,
  isRewritableContentType,
  isSafeStagedLocation,
  mediaSecurityHeaders,
  NOSNIFF,
  originRewritePairs,
  originRewriteStream,
  type RedirectPlan,
  type RedirectTableRow,
  readSessionCookie,
  STAGING_ACCESS_PATH,
  STAGING_CHECK_PATH,
  STAGING_RUN_TOKEN_HEADER,
  STAGING_SESSION_ENTRY,
  STAGING_SESSION_TTL_SECONDS,
  type StagedManifest,
  type StagingAccessSettings,
  safeStagingNextPath,
  sessionSetCookieHeader,
  signStagingToken,
  stagedFileKey,
  stagedKeysFor,
  stagedManifestKey,
  stagedManifestSchema,
  stagingIpAllowlistSupported,
  verifyStagingRunToken,
  verifyStagingToken,
} from "@caelo-cms/shared";
import { type MemoryLimitSpec, MemoryRateLimiter } from "../middleware/memory-limiter.js";
import type { StagingStorage } from "./storage.js";

/** Start-of-answer budget for a staged file, under Firebase's 60 s cut. */
export const FIRST_BYTE_BUDGET_MS = 45_000;

/**
 * Gate failures per client: 30 at once, then one every 10 s. A browser that
 * was never let in makes a handful (the page and its favicon); this only
 * stops a client from making the gateway compute HMACs as fast as it can.
 */
export const GATE_FAILURE_LIMIT: MemoryLimitSpec = { capacity: 30, refillPerSec: 0.1 };

/** The served build, as the admin published it. */
export interface ServedBuild {
  readonly runId: string;
  /** Where its complete files lie in staging storage (`_slots/a`, `builds/<runId>`). */
  readonly location: string;
  /** The origin its pages were rendered for (the live site's), rewritten to the staging host. */
  readonly buildOrigin: string | null;
}

/** What the gateway serves staging from, published into cms_public_staging (`published_staging_site`). */
export interface StagingSiteState {
  /** The staging host (`staging_access.staging_host`); null until set. */
  readonly host: string | null;
  readonly settings: StagingAccessSettings;
  /** The gate key; null until a process holding it published it. */
  readonly gateSecret: string | null;
  /** Null until the first Stage after the update filled a slot. */
  readonly served: ServedBuild | null;
}

/** Everything one staging request needs. */
export interface StagingSiteDeps {
  readonly state: StagingSiteState;
  /** The client address under the deployment's proxy hops (client-ip.ts). */
  readonly clientIp: string;
  /** Bucket key of {@link clientIp} for the failure budget (rateLimitAddress). */
  readonly clientKey: string;
  /** `CAELO_PROVIDER`: whether the IP allowlist can be trusted, the status of a gone row. */
  readonly provider: string | undefined;
  readonly storage: StagingStorage;
  readonly manifests: ManifestCache;
  /** The published redirects table (cached by the caller like every projection read). */
  readonly redirects: () => Promise<readonly RedirectTableRow[]>;
  readonly failures: MemoryRateLimiter;
  /** The visitor routes (`/api/*`) of this gateway. */
  readonly api: (req: Request) => Promise<Response>;
  readonly secure: boolean;
  readonly nowSeconds?: () => number;
  /** Override {@link FIRST_BYTE_BUDGET_MS} (tests). */
  readonly firstByteBudgetMs?: number;
}

/** A gateway-wide failure budget, one bucket per client. */
export function gateFailureLimiter(): MemoryRateLimiter {
  return new MemoryRateLimiter(GATE_FAILURE_LIMIT);
}

// ─── pages the gate itself answers ─────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function stagingHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex");
  headers.set("X-Content-Type-Options", NOSNIFF);
  return headers;
}

/** A short HTML page the gate answers with (never staged content). */
export function gatePage(
  status: number,
  title: string,
  body: string,
  extra: HeadersInit = {},
): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
  const headers = stagingHeaders(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  return new Response(html, { status, headers });
}

// ─── the served build's manifest and redirect plan ─────────────────────

interface LoadedBuild {
  readonly manifest: StagedManifest;
  readonly files: ReadonlySet<string>;
  /** Redirect plan by the redirects rows it was built from. */
  plan: { readonly rows: readonly RedirectTableRow[]; readonly plan: RedirectPlan } | null;
}

/**
 * Manifests of the served builds, by location and run. A slot's files
 * change only when a later Stage resyncs it under another run, so a run's
 * manifest never goes stale; two entries cover the A/B flip.
 */
export class ManifestCache {
  private readonly loaded = new Map<string, Promise<LoadedBuild>>();

  async get(
    storage: StagingStorage,
    served: ServedBuild,
    signal?: AbortSignal,
  ): Promise<LoadedBuild> {
    const key = `${served.location}@${served.runId}`;
    let entry = this.loaded.get(key);
    if (!entry) {
      entry = loadBuild(storage, served, signal);
      this.loaded.set(key, entry);
      // A failed read is not cached: the next request reads again.
      entry.catch(() => this.loaded.delete(key));
      while (this.loaded.size > 2) {
        const oldest = this.loaded.keys().next().value;
        if (oldest === undefined) break;
        this.loaded.delete(oldest);
      }
    }
    return entry;
  }
}

async function loadBuild(
  storage: StagingStorage,
  served: ServedBuild,
  signal?: AbortSignal,
): Promise<LoadedBuild> {
  if (!isSafeStagedLocation(served.location)) {
    throw new Error(`the published served location "${served.location}" is not a staging location`);
  }
  const text = await storage.readText(stagedManifestKey(served.location), signal);
  if (text === null) {
    throw new Error(
      `the manifest of the served build (${storage.describe}/${stagedManifestKey(served.location)}) is missing — Stage again`,
    );
  }
  const parsed = stagedManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`the manifest of the served build is not valid: ${parsed.error.message}`);
  }
  if (parsed.data.runId !== served.runId) {
    throw new Error(
      `the served slot ${served.location} holds run ${parsed.data.runId}, but the projection names ${served.runId} — a Stage is resyncing it; Stage again if this persists`,
    );
  }
  return { manifest: parsed.data, files: new Set(Object.keys(parsed.data.files)), plan: null };
}

function redirectPlanFor(build: LoadedBuild, rows: readonly RedirectTableRow[]): RedirectPlan {
  if (build.plan?.rows !== rows) {
    build.plan = {
      rows,
      plan: buildRedirectPlan({
        rows,
        pageUrlStyle: build.manifest.pageUrlStyle,
        servedFiles: build.files,
      }),
    };
  }
  return build.plan.plan;
}

// ─── the handler ───────────────────────────────────────────────────────

function sessionCookie(req: Request, token: string, now: number, secure: boolean): string {
  // Keep the other owners' entries (visitor id, login) as they came.
  const entries = new Map(readSessionCookie(req.headers.get("cookie"), now));
  entries.set(STAGING_SESSION_ENTRY, {
    value: token,
    expiresAt: now + STAGING_SESSION_TTL_SECONDS,
  });
  return sessionSetCookieHeader(entries, { nowSeconds: now, secure });
}

/** Serve one request on the staging gateway (see the module comment). */
export async function handleStagingSiteRequest(
  req: Request,
  deps: StagingSiteDeps,
): Promise<Response> {
  const url = new URL(req.url);
  const { state } = deps;
  const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (!state.gateSecret) {
    return gatePage(
      503,
      "Staging is not ready",
      "The staging gate key has not been published yet. Start the Caelo admin once (it publishes it), or run the update again.",
    );
  }
  const secret = state.gateSecret;

  // Before any HMAC, on every path the gate answers — the token exchange and
  // the serve check included: a client that used up its failure budget waits
  // it out whatever it presents (DoS only).
  if (!deps.failures.peek(deps.clientKey).allowed) {
    return gatePage(429, "Too many attempts", "Try again in a few minutes.", {
      "Retry-After": "60",
    });
  }

  if (url.pathname === STAGING_ACCESS_PATH) {
    const token = url.searchParams.get("t") ?? "";
    const valid =
      req.method === "GET" &&
      state.settings.cookieEnabled &&
      (await verifyStagingToken(secret, token, "open", now));
    if (!valid) {
      deps.failures.take(deps.clientKey);
      return gatePage(
        403,
        "This staging link has expired",
        "Staging links from the admin work for two minutes. Open staging again from the Caelo admin.",
      );
    }
    const session = await signStagingToken(secret, "session", now + STAGING_SESSION_TTL_SECONDS);
    return new Response(null, {
      status: 303,
      headers: stagingHeaders({
        Location: safeStagingNextPath(url.searchParams.get("next")),
        "Set-Cookie": sessionCookie(req, session, now, deps.secure),
      }),
    });
  }

  if (url.pathname === STAGING_CHECK_PATH) return stagingCheck(req, url, deps, secret, now);

  const decision = await decideStagingAccess({
    settings: state.settings,
    secret,
    nowSeconds: now,
    request: {
      cookieHeader: req.headers.get("cookie"),
      authorizationHeader: req.headers.get("authorization"),
      header: (name) => req.headers.get(name),
      clientIp: stagingIpAllowlistSupported(deps.provider) ? deps.clientIp : null,
    },
  });
  if (!decision.allowed) {
    deps.failures.take(deps.clientKey);
    if (decision.status === 401) {
      return gatePage(
        401,
        "Staging login required",
        "Log in with the staging credentials, or open staging from the Caelo admin.",
        { "WWW-Authenticate": 'Basic realm="Caelo staging", charset="UTF-8"' },
      );
    }
    return gatePage(
      403,
      "This is a protected staging site",
      "It shows unpublished changes. Open it from the Caelo admin (Open staging); crawlers and tools use the access configured under Settings → Staging access.",
    );
  }

  if (url.pathname.startsWith("/api/")) {
    const answer = await deps.api(req);
    const headers = new Headers(answer.headers);
    headers.set("X-Robots-Tag", "noindex");
    // No shared cache may keep an admitted answer for someone the gate would refuse.
    headers.set("Cache-Control", "private, no-store");
    return new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers,
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return gatePage(405, "Not allowed", "The staged site only answers GET and HEAD.", {
      Allow: "GET, HEAD",
    });
  }
  if (!state.served) {
    return gatePage(
      503,
      "Nothing has been staged yet",
      "Stage changes in the Caelo admin to see them here. After that, staging always shows the last staged build — also once it is live.",
    );
  }
  return serveStagedPath(req, url, state, state.served, deps);
}

/**
 * The admin's serve check (#1330): with a per-run `check` token, which run
 * the manifest at `?location=` holds — the proof that the admin wrote the
 * build where this gateway reads (a self-hosted mount, a bucket name). It
 * reads only a manifest the location names and returns only its run id.
 */
async function stagingCheck(
  req: Request,
  url: URL,
  deps: StagingSiteDeps,
  secret: string,
  now: number,
): Promise<Response> {
  const token = req.headers.get(STAGING_RUN_TOKEN_HEADER) ?? "";
  const run = await verifyStagingRunToken(secret, token, now);
  if (req.method !== "GET" || run?.purpose !== "check") {
    deps.failures.take(deps.clientKey);
    return gatePage(403, "Not allowed", "This path answers the Caelo admin's serve check only.");
  }
  const location = url.searchParams.get("location") ?? "";
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: stagingHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  if (!isSafeStagedLocation(location)) return json(400, { ok: false, error: "bad location" });
  let text: string | null;
  try {
    text = await deps.storage.readText(
      stagedManifestKey(location),
      AbortSignal.timeout(FIRST_BYTE_BUDGET_MS),
    );
  } catch (e) {
    // The reason goes to the log only, never into an answer.
    console.error(
      `[api-gateway] staging check of ${location} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return json(502, { ok: false, error: "staging storage unreadable" });
  }
  if (text === null) return json(404, { ok: false, error: `no manifest at ${location}` });
  const parsed = stagedManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return json(422, { ok: false, error: "the manifest is not valid" });
  return json(200, {
    ok: true,
    runId: parsed.data.runId,
    files: Object.keys(parsed.data.files).length,
  });
}

/**
 * The first-byte budget of one staged file: it aborts the storage read only
 * while the answer has not started. Cleared once the file is open, so a
 * large file that takes longer than the budget to stream is never cut.
 */
function firstByteBudget(ms: number): { readonly signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("the staged file did not start in time")),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function serveStagedPath(
  req: Request,
  url: URL,
  state: StagingSiteState,
  served: ServedBuild,
  deps: StagingSiteDeps,
): Promise<Response> {
  const budget = firstByteBudget(deps.firstByteBudgetMs ?? FIRST_BYTE_BUDGET_MS);
  try {
    return await serveStagedPathWithin(req, url, state, served, deps, budget.signal);
  } finally {
    // The answer has started (or failed): its body streams without a deadline.
    budget.clear();
  }
}

async function serveStagedPathWithin(
  req: Request,
  url: URL,
  state: StagingSiteState,
  served: ServedBuild,
  deps: StagingSiteDeps,
  signal: AbortSignal,
): Promise<Response> {
  let build: LoadedBuild;
  try {
    build = await deps.manifests.get(deps.storage, served, signal);
  } catch (e) {
    console.error(
      `[api-gateway] staging build unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return gatePage(
      503,
      "Staging is unavailable",
      "The staged build could not be read. Try again in a moment; if it persists, Stage again from the Caelo admin.",
    );
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return gatePage(400, "Bad request", "The address is not valid.");
  }
  const plan = redirectPlanFor(build, await deps.redirects());
  const redirect = plan.redirects.find((r) => r.matchPaths.includes(decodedPath));
  if (redirect) {
    const location = redirect.preserveQuery
      ? `${redirect.location}${url.search}`
      : redirect.location;
    return new Response(null, {
      status: redirect.statusCode,
      headers: stagingHeaders({ Location: location }),
    });
  }
  if (plan.gone.some((g) => g.matchPaths.includes(decodedPath))) {
    return notFound(req, state, served, build, deps, signal, goneStatusOnProvider(deps.provider));
  }

  const keys = stagedKeysFor(url.pathname);
  if (keys === null) return gatePage(400, "Bad request", "The address is not valid.");
  const path = keys.find((k) => build.files.has(k));
  if (!path) return notFound(req, state, served, build, deps, signal, 404);
  return serveFile(req, state, served, build, path, 200, deps, signal);
}

function notFound(
  req: Request,
  state: StagingSiteState,
  served: ServedBuild,
  build: LoadedBuild,
  deps: StagingSiteDeps,
  signal: AbortSignal,
  status: number,
): Promise<Response> | Response {
  if (build.files.has("404.html")) {
    return serveFile(req, state, served, build, "404.html", status, deps, signal);
  }
  return gatePage(status, "Not found", "This page is not part of the staged build.");
}

async function serveFile(
  req: Request,
  state: StagingSiteState,
  served: ServedBuild,
  build: LoadedBuild,
  path: string,
  status: number,
  deps: StagingSiteDeps,
  signal: AbortSignal,
): Promise<Response> {
  const entry = build.manifest.files[path];
  if (!entry) return gatePage(404, "Not found", "This page is not part of the staged build.");
  let object: Awaited<ReturnType<StagingStorage["open"]>>;
  try {
    object = await deps.storage.open(stagedFileKey(served.location, path), signal);
  } catch (e) {
    const timedOut = signal.aborted;
    console.error(
      `[api-gateway] staged file ${path} ${timedOut ? "did not start within the budget" : "unreadable"}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return gatePage(
      timedOut ? 504 : 502,
      "Staging is unavailable",
      "The staged file could not be loaded. Try again in a moment.",
    );
  }
  if (!object) {
    // Listed in the manifest but not in storage: the slot is incomplete.
    console.error(
      `[api-gateway] staged file ${path} is listed but missing in ${deps.storage.describe}/${served.location}`,
    );
    return gatePage(
      502,
      "Staging is incomplete",
      "A file of the staged build is missing. Stage again from the Caelo admin.",
    );
  }
  const headers = stagingHeaders({
    "Content-Type": entry.type,
    ...mediaSecurityHeaders(entry.type),
    // #1454 — the headers Publish live ships with this build.
    ...(isHtmlContentType(entry.type) ? build.manifest.securityHeaders : {}),
  });
  const rewrite =
    state.host !== null && served.buildOrigin !== null && isRewritableContentType(entry.type);
  if (req.method === "HEAD") {
    await object.body.cancel();
    if (!rewrite && object.size !== null) headers.set("Content-Length", String(object.size));
    return new Response(null, { status, headers });
  }
  if (!rewrite) {
    if (object.size !== null) headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status, headers });
  }
  const pairs = originRewritePairs(served.buildOrigin as string, `https://${state.host}`);
  return new Response(object.body.pipeThrough(originRewriteStream(pairs)), { status, headers });
}
