// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway's health check for upgrades (epic #696).
 *
 *   GET /api/_caelo/health         → `{ ok }` (liveness)
 *   GET /api/_caelo/health?deep=1  → also proves the database login works
 *                                    (public_role on cms_public — the gateway
 *                                    has no other, #635); 503 otherwise
 *
 * Under `/api/` because that is the only path the gcp load balancer routes to
 * the gateway. The gateway is public by design, so the answer carries a
 * failure kind at most: no database error and, since #1326, no release
 * version either — a public version string tells an attacker which known
 * flaw to try. The upgrade checks the release a service runs where it can
 * be trusted, from the platform's own record of the serving revision.
 *
 * The deep check costs one round trip only until it first succeeds
 * (`verifyRoles` remembers success). It is throttled per client before that
 * round trip (#1326): the cheap setup has no WAF in front (E3), so nothing
 * else would stop a loop of deep checks against a database that is down.
 */

import { DEEP_HEALTH_MEMORY_LIMIT, MemoryRateLimiter } from "./middleware/memory-limiter.js";
import { JSON_SECURITY_HEADERS } from "./middleware/security-headers.js";

/** The path the gateway answers its health check on. */
export const GATEWAY_HEALTH_PATH = "/api/_caelo/health";

/** What the deep check needs from the database adapter. */
export interface HealthAdapter {
  verifyRoles(): Promise<void>;
}

/** Per-client throttle of the deep check (one per gateway instance). */
const deepLimiter = new MemoryRateLimiter(DEEP_HEALTH_MEMORY_LIMIT);

/**
 * Answer a health request; `adapter` is null until the gateway bootstrapped.
 *
 * @param client the caller's rate-limit address (client-ip.ts), which the
 *   deep check is throttled by; null only when the address is unknown,
 *   where the deep check is refused rather than left unthrottled.
 */
export async function gatewayHealth(
  url: URL,
  adapter: HealthAdapter | null,
  client: string | null,
  limiter: MemoryRateLimiter = deepLimiter,
): Promise<Response> {
  const answer = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...JSON_SECURITY_HEADERS,
        ...extra,
      },
    });
  if (url.searchParams.get("deep") !== "1") return answer(200, { ok: true });
  const take = client === null ? null : limiter.take(client);
  if (!take?.allowed) {
    return answer(
      429,
      { ok: false, error: { kind: "RateLimited" } },
      {
        "Retry-After": String(take?.retryAfterSec ?? 60),
      },
    );
  }
  if (!adapter) return answer(503, { ok: false, error: { kind: "NotBootstrapped" } });
  try {
    await adapter.verifyRoles();
  } catch (e) {
    console.error(`[api-gateway] health: ${e instanceof Error ? e.message : String(e)}`);
    return answer(503, { ok: false, error: { kind: "DbUnreachable" } });
  }
  return answer(200, { ok: true });
}
