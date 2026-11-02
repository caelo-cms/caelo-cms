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

/** Who asks, for the deep check's throttle and the error answer. */
export interface HealthRequest {
  /**
   * The caller's rate-limit address (client-ip.ts), which the deep check is
   * throttled by; null only when the address is unknown, where the deep
   * check is refused rather than left unthrottled.
   */
  readonly client: string | null;
  /** The request id an error answer carries (body and `X-Request-Id`, #1326). */
  readonly requestId: string;
  /** The deep check's throttle; one per gateway instance unless a test passes its own. */
  readonly limiter?: MemoryRateLimiter;
}

/** Answer a health request; `adapter` is null until the gateway bootstrapped. */
export async function gatewayHealth(
  url: URL,
  adapter: HealthAdapter | null,
  request: HealthRequest,
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
  const failure = (status: number, kind: string, extra: Record<string, string> = {}) =>
    answer(
      status,
      { ok: false, error: { kind, requestId: request.requestId } },
      { "X-Request-Id": request.requestId, ...extra },
    );
  if (url.searchParams.get("deep") !== "1") return answer(200, { ok: true });
  const limiter = request.limiter ?? deepLimiter;
  const take = request.client === null ? null : limiter.take(request.client);
  if (!take?.allowed) {
    return failure(429, "RateLimited", { "Retry-After": String(take?.retryAfterSec ?? 60) });
  }
  if (!adapter) return failure(503, "NotBootstrapped");
  try {
    await adapter.verifyRoles();
  } catch (e) {
    console.error(
      `[api-gateway] request ${request.requestId}: health — ${e instanceof Error ? e.message : String(e)}`,
    );
    return failure(503, "DbUnreachable");
  }
  return answer(200, { ok: true });
}
