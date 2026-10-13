// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway's health check for upgrades (epic #696).
 *
 *   GET /api/_caelo/health         → `{ ok, version }` (liveness)
 *   GET /api/_caelo/health?deep=1  → also proves both database logins work
 *                                    (gateway_role on cms_admin, public_role
 *                                    on cms_public); 503 otherwise
 *
 * Under `/api/` because that is the only path the gcp load balancer routes to
 * the gateway. The gateway is public by design, so the answer carries nothing
 * but the release version and a failure kind — never a database error. The
 * deep check costs one round trip per pool only until it first succeeds
 * (`verifyRoles` remembers success), so it is no amplification vector behind
 * the WAF's rate limits.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";

/** The path the gateway answers its health check on. */
export const GATEWAY_HEALTH_PATH = "/api/_caelo/health";

/** What the deep check needs from the database adapter. */
export interface HealthAdapter {
  verifyRoles(): Promise<void>;
}

/** Answer a health request; `adapter` is null until the gateway bootstrapped. */
export async function gatewayHealth(url: URL, adapter: HealthAdapter | null): Promise<Response> {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers });
  if (url.searchParams.get("deep") !== "1")
    return answer(200, { ok: true, version: CAELO_VERSION });
  if (!adapter) {
    return answer(503, { ok: false, version: CAELO_VERSION, error: { kind: "NotBootstrapped" } });
  }
  try {
    await adapter.verifyRoles();
  } catch (e) {
    console.error(`[api-gateway] health: ${e instanceof Error ? e.message : String(e)}`);
    return answer(503, { ok: false, version: CAELO_VERSION, error: { kind: "DbUnreachable" } });
  }
  return answer(200, { ok: true, version: CAELO_VERSION });
}
