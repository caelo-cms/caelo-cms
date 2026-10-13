// SPDX-License-Identifier: MPL-2.0

/**
 * Deep health check after an app-roll (epic #696).
 *
 * Cloud Run's readiness only proves the new container listens on its port. A
 * revision can do that while it cannot reach the database, runs against a
 * schema its migrations never reached, or is not the release the roll asked
 * for. After both services moved, the app-roll asks them:
 *
 *   - admin   `GET /_caelo/health?deep=1` → `{ ok, version, migrations }`:
 *             both databases reachable as the expected roles, and every
 *             migration the image ships recorded as applied.
 *   - gateway `GET /api/_caelo/health?deep=1` → `{ ok, version }`: its
 *             database logins work. Under `/api/` because that is the only
 *             path the gcp load balancer routes to the gateway.
 *
 * Both answer with no secrets and no raw database errors. The admin sits
 * behind IAP, so the probe signs an IAP credential as the install's MCP
 * service account (`caelo-mcp@`, mcp-iap.ts) exactly like the MCP shim does
 * (packages/mcp-server/src/ingress-auth.ts): a JWT with `aud` = the admin
 * origin + `/*`, signed through the IAM Credentials API by whoever runs the
 * upgrade (the converge step lets every IAP-allowlisted operator sign as
 * that account). The gateway is public by design and gets no credential.
 *
 * Before anything changes, {@link HealthProbe.baseline} proves the probe can
 * reach both services at all. Otherwise a DNS, certificate or IAP problem
 * would only show after migrations, as a "failed" health check that rolls a
 * healthy release back.
 */

import type { GcloudRunner, Sleep } from "../gcloud-retry.js";
import { mcpIapServiceAccountEmail } from "../gcp-names.js";
import type { HttpFetch } from "../runtime-secrets.js";

export type HealthOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly error: string };

export interface HealthProbe {
  /** Reach both services as they serve now (before any change). */
  baseline(): Promise<HealthOutcome>;
  /**
   * Deep-check both services after the roll, retrying while the new
   * revisions warm up. `version` is the release the roll targets (null when
   * a channel tag like `latest` was rolled: then both must report the same
   * version).
   */
  deep(expect: { readonly version: string | null }): Promise<HealthOutcome>;
}

interface MigrationState {
  readonly head: string | null;
  readonly pending: number;
}

/** What `/_caelo/health?deep=1` answers (apps/admin/src/routes/_caelo/health). */
interface AdminDeepBody {
  readonly ok?: boolean;
  readonly version?: string;
  readonly migrations?: { readonly admin?: MigrationState; readonly public?: MigrationState };
  readonly error?: { readonly kind?: string; readonly message?: string };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Judge the admin's deep health answer.
 *
 * @returns the version the admin runs on success
 */
export function evaluateAdminDeepHealth(
  status: number,
  text: string,
  expectedVersion: string | null,
): { ok: true; version: string; detail: string } | { ok: false; error: string } {
  const body = parseJson<AdminDeepBody>(text);
  if (!body) return { ok: false, error: `admin answered HTTP ${status} without JSON` };
  const m = body.migrations;
  // Pending migrations come with a 503; name them rather than "unhealthy".
  for (const [db, state] of [
    ["cms_admin", m?.admin],
    ["cms_public", m?.public],
  ] as const) {
    if (state && state.pending !== 0) {
      return {
        ok: false,
        error: `${db} is missing ${state.pending} migration(s) the new admin image ships (applied head: ${state.head ?? "none"})`,
      };
    }
  }
  if (status !== 200 || body.ok !== true) {
    const why = body.error ? `${body.error.kind ?? "?"}: ${body.error.message ?? ""}` : "no reason";
    return { ok: false, error: `admin reports unhealthy (HTTP ${status}, ${why})` };
  }
  if (!body.version) return { ok: false, error: "admin reported no version" };
  if (expectedVersion !== null && body.version !== expectedVersion) {
    return {
      ok: false,
      error: `admin runs ${body.version}, the roll targeted ${expectedVersion}`,
    };
  }
  if (!m?.admin || !m.public) {
    return {
      ok: false,
      error:
        "admin did not report its migration state (its image predates the deep health check; pass --skip-health-check to roll to such a release)",
    };
  }
  return {
    ok: true,
    version: body.version,
    detail: `admin ${body.version}, migrations at ${m.admin.head ?? "?"} / ${m.public.head ?? "?"}`,
  };
}

/** Judge the gateway's deep health answer against the version the admin runs. */
export function evaluateGatewayDeepHealth(
  status: number,
  text: string,
  expectedVersion: string,
): HealthOutcome {
  const body = parseJson<{ ok?: boolean; version?: string; error?: { kind?: string } }>(text);
  if (!body) return { ok: false, error: `gateway answered HTTP ${status} without JSON` };
  if (status !== 200 || body.ok !== true) {
    return {
      ok: false,
      error: `gateway reports unhealthy (HTTP ${status}, ${body.error?.kind ?? "no reason"})`,
    };
  }
  if (body.version !== expectedVersion) {
    return {
      ok: false,
      error: `gateway runs ${body.version ?? "an unknown version"}, the admin runs ${expectedVersion}`,
    };
  }
  return { ok: true, detail: `gateway ${body.version}` };
}

/** Where the probe reaches the install. */
export interface HealthTarget {
  readonly provider: "gcp" | "gcp-firebase";
  readonly projectId: string;
  readonly domain: string;
  /** The admin service's `run.app` URL (IAP-gated on gcp-firebase). */
  readonly adminServiceUrl: string;
  /** The gateway service's `run.app` URL (public on gcp-firebase). */
  readonly gatewayServiceUrl: string;
}

/**
 * The origins the probe calls. On gcp the admin's IAP lives on the load
 * balancer (`admin.<domain>`) and the gateway's ingress is load-balancer-only
 * (`<domain>/api/*`); on gcp-firebase both `run.app` URLs are reachable — the
 * admin's through Cloud Run's own IAP, the gateway's publicly.
 */
export function healthOrigins(target: HealthTarget): { admin: string; gateway: string } {
  return target.provider === "gcp"
    ? { admin: `https://admin.${target.domain}`, gateway: `https://${target.domain}` }
    : {
        admin: new URL(target.adminServiceUrl).origin,
        gateway: new URL(target.gatewayServiceUrl).origin,
      };
}

export interface HealthProbeDeps {
  readonly run: GcloudRunner;
  readonly http: HttpFetch;
  readonly sleep: Sleep;
  /** Deep-check attempts while the new revisions warm up (default 12). */
  readonly attempts?: number;
  /** Pause between attempts in ms (default 5000). */
  readonly intervalMs?: number;
  /** Seconds since epoch. */
  readonly now?: () => number;
}

const JWT_LIFETIME_S = 600;
const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";

/** The IAP-backed probe of a gcp / gcp-firebase install. */
export function createIapHealthProbe(target: HealthTarget, deps: HealthProbeDeps): HealthProbe {
  const origins = healthOrigins(target);
  const signer = mcpIapServiceAccountEmail(target.projectId);
  const attempts = deps.attempts ?? 12;
  const intervalMs = deps.intervalMs ?? 5_000;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  /**
   * A JWT IAP accepts for the admin origin, signed as the MCP service
   * account. Never throws: a transport failure is a failed outcome, so the
   * retries and the app-roll's rollback still run.
   */
  async function iapToken(): Promise<{ ok: true; jwt: string } | { ok: false; error: string }> {
    try {
      return await signIapToken();
    } catch (e) {
      return {
        ok: false,
        error: `could not sign an IAP credential as ${signer}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async function signIapToken(): Promise<{ ok: true; jwt: string } | { ok: false; error: string }> {
    const token = await deps.run(["auth", "print-access-token"]);
    const bearer = token.ok ? token.stdout.trim() : "";
    if (!bearer) {
      return {
        ok: false,
        error: `gcloud auth print-access-token: ${token.stderr.trim() || "empty"}`,
      };
    }
    const iat = now();
    const res = await deps.http(`${IAM_CREDENTIALS}/${encodeURIComponent(signer)}:signJwt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: JSON.stringify({
          iss: signer,
          sub: signer,
          aud: `${origins.admin}/*`,
          iat,
          exp: iat + JWT_LIFETIME_S,
        }),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `could not sign an IAP credential as ${signer} (HTTP ${res.status}). Your account needs roles/iam.serviceAccountTokenCreator on it — upgrade's converge step grants it to every IAP-allowlisted user. ${text.slice(0, 300)}`,
      };
    }
    const jwt = parseJson<{ signedJwt?: string }>(text)?.signedJwt;
    return jwt ? { ok: true, jwt } : { ok: false, error: "signJwt returned no signedJwt" };
  }

  async function get(url: string, headers: Record<string, string>) {
    try {
      const res = await deps.http(url, { method: "GET", headers });
      return { reached: true as const, status: res.status, text: await res.text() };
    } catch (e) {
      return { reached: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    async baseline() {
      const token = await iapToken();
      if (!token.ok) return token;
      const auth = { Authorization: `Bearer ${token.jwt}` };
      const admin = await get(`${origins.admin}/_caelo/health`, auth);
      if (!admin.reached) {
        return { ok: false, error: `admin unreachable at ${origins.admin}: ${admin.error}` };
      }
      // The serving (old) admin answers its shallow health JSON. Anything
      // else — IAP's login redirect, a 401/403, an HTML error page — means
      // the probe would not see the new revision either.
      const body = parseJson<{ version?: string }>(admin.text);
      if (!body?.version) {
        return {
          ok: false,
          error: `admin at ${origins.admin} did not answer its health check (HTTP ${admin.status}); IAP may not admit ${signer}`,
        };
      }
      const gateway = await get(`${origins.gateway}/api/_caelo/health`, {});
      if (!gateway.reached) {
        return { ok: false, error: `gateway unreachable at ${origins.gateway}: ${gateway.error}` };
      }
      return { ok: true, detail: `admin ${body.version} and gateway reachable` };
    },

    async deep(expect) {
      let last: HealthOutcome = { ok: false, error: "no attempt made" };
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await deps.sleep(intervalMs);
        last = await deepOnce(expect.version);
        if (last.ok) return last;
      }
      return last;
    },
  };

  async function deepOnce(expectedVersion: string | null): Promise<HealthOutcome> {
    const token = await iapToken();
    if (!token.ok) return token;
    const admin = await get(`${origins.admin}/_caelo/health?deep=1`, {
      Authorization: `Bearer ${token.jwt}`,
    });
    if (!admin.reached) return { ok: false, error: `admin unreachable: ${admin.error}` };
    const a = evaluateAdminDeepHealth(admin.status, admin.text, expectedVersion);
    if (!a.ok) return a;
    const gateway = await get(`${origins.gateway}/api/_caelo/health?deep=1`, {});
    if (!gateway.reached) return { ok: false, error: `gateway unreachable: ${gateway.error}` };
    const g = evaluateGatewayDeepHealth(gateway.status, gateway.text, a.version);
    return g.ok ? { ok: true, detail: `${a.detail}; ${g.detail}` } : g;
  }
}
