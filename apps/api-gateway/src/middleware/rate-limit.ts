// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — gateway rate limiter.
 *
 * Wraps the existing PostgresRateLimiter with per-(plugin, operation)
 * limits resolved from:
 *   1. `plugin_rate_limit_overrides` row (Owner-set or §11.A approved), as
 *      the admin publishes it into cms_public (`published_rate_limits`, #635)
 *   2. plugin manifest's `gateway.rateLimits[op]`
 *   3. default fallback (30 req / 60s)
 *
 * Key: `gateway-ip:${pluginSlug}:${operation}:${clientAddressHash}` —
 * never the visitor cookie, which a client sheds at will (see
 * {@link ipScopedRateLimitKey}).
 *
 * Token-bucket overlay (10 tokens, refill 1/s) lives in the same row's
 * `tokens_remaining` + `last_refill_at` columns; a single tx checks the
 * sliding window AND the burst tokens — one round-trip per request.
 */

import type { LoadedPlugin } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { publishedCacheUsable } from "../published-changes.js";

export interface RateLimitSpec {
  readonly perVisitorMax: number;
  readonly windowSeconds: number;
}

const DEFAULT_SPEC: RateLimitSpec = { perVisitorMax: 30, windowSeconds: 60 };
const BURST_TOKENS = 10;
const BURST_REFILL_PER_SEC = 1;

// P13 audit re-pass — cache spec lookups. Most public POSTs hit plugins
// with no override row; without this cache we burn one DB roundtrip per
// request just to find out. Served only while the gateway listens for the
// admin's publish notifications, and cleared on each (#1267,
// published-changes.ts) via invalidateRateLimitSpecCache().
const specCache = new Map<string, RateLimitSpec>();

export function invalidateRateLimitSpecCache(): void {
  specCache.clear();
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSec: number;
  readonly limit: number;
  readonly windowSec: number;
  readonly remaining: number;
}

interface OverrideRow {
  per_visitor_max: number;
  window_seconds: number;
}

interface ManifestRateLimits {
  readonly rateLimits?: Record<string, { perVisitor?: { max?: number; windowSec?: number } }>;
}

export async function resolveRateLimitSpec(
  adapter: DatabaseAdapter,
  pluginSlug: string,
  operation: string,
  plugin?: LoadedPlugin,
): Promise<RateLimitSpec> {
  // P13 audit re-pass — cache hit fast path.
  const cacheKey = `${pluginSlug}:${operation}`;
  const cached = specCache.get(cacheKey);
  if (cached && publishedCacheUsable()) return cached;
  // 1. Check overrides table.
  // The override as the admin published it (#635), its profile already
  // dereferenced at publish time.
  const rows = await adapter.withPublicTransaction(
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "rl-resolve",
    },
    async (tx) =>
      (await tx.execute(sql`
        SELECT per_visitor_max, window_seconds
        FROM published_rate_limits
        WHERE plugin_slug = ${pluginSlug} AND operation = ${operation}
        LIMIT 1
      `)) as unknown as OverrideRow[],
  );
  let resolved: RateLimitSpec;
  if (rows[0]) {
    resolved = { perVisitorMax: rows[0].per_visitor_max, windowSeconds: rows[0].window_seconds };
  } else {
    // 2. Plugin manifest.
    const manifestGateway = (
      plugin?.definition as { manifest?: { gateway?: ManifestRateLimits } } | undefined
    )?.manifest?.gateway;
    const opSpec = manifestGateway?.rateLimits?.[operation]?.perVisitor;
    resolved =
      opSpec?.max && opSpec?.windowSec
        ? { perVisitorMax: opSpec.max, windowSeconds: opSpec.windowSec }
        : DEFAULT_SPEC;
  }
  specCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Atomic check + increment. Returns whether the request is allowed,
 * suggested Retry-After, and remaining budget for headers.
 *
 * P13 audit fix #3 — concurrency safety. The previous single-statement
 * UPSERT computed `tokens_remaining = …current… - 1` inside the SET
 * expression. That arithmetic is correct against the row's current
 * value, but two concurrent UPSERTs serialise their *writes*, not their
 * read of `current`. Under genuine concurrent burst, both could
 * end up with the same post-decrement value (the second write reads
 * the row's value AFTER the first write commits, yes — but the
 * `LEAST(…, current + refill - 1)` clamp can hide a missed decrement
 * via the LEAST cap). The robust fix is the classic
 * `pg_advisory_xact_lock` per-key + read + compute + write inside a
 * single tx. Advisory locks are cheap (no row write needed) and scope
 * to the tx, so they release automatically on commit/rollback.
 */
export async function consumeRateLimit(
  adapter: DatabaseAdapter,
  args: {
    key: string;
    spec: RateLimitSpec;
  },
): Promise<RateLimitDecision> {
  const { key, spec } = args;
  const windowMs = spec.windowSeconds * 1000;

  const row = await adapter.withPublicTransaction(
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "rl-consume",
    },
    async (tx) => {
      // Per-key advisory lock — serialises concurrent consumers of the
      // same bucket inside the tx. `hashtext` keeps the int8 input
      // domain bounded; collisions across keys are harmless (extra
      // serialisation, no correctness loss).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);

      // Read existing row (NULL on first hit).
      const existing = (await tx.execute(sql`
        SELECT count, window_start, expires_at, tokens_remaining, last_refill_at
        FROM gateway_rate_limit_buckets
        WHERE key = ${key}
        LIMIT 1
      `)) as unknown as Array<{
        count: number;
        window_start: string | Date;
        expires_at: string | Date;
        tokens_remaining: number;
        last_refill_at: string | Date;
      }>;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const e = existing[0];
      let newCount: number;
      let newWindowStartIso: string;
      let newExpiresAtMs: number;
      let newTokens: number;
      let newLastRefillIso: string;
      if (!e) {
        newCount = 1;
        newWindowStartIso = nowIso;
        newExpiresAtMs = now + windowMs;
        newTokens = BURST_TOKENS - 1;
        newLastRefillIso = nowIso;
      } else {
        const windowStartMs =
          e.window_start instanceof Date
            ? e.window_start.getTime()
            : Date.parse(String(e.window_start));
        const expiresMs =
          e.expires_at instanceof Date ? e.expires_at.getTime() : Date.parse(String(e.expires_at));
        const lastRefillMs =
          e.last_refill_at instanceof Date
            ? e.last_refill_at.getTime()
            : Date.parse(String(e.last_refill_at));
        if (expiresMs < now) {
          newCount = 1;
          newWindowStartIso = nowIso;
          newExpiresAtMs = now + windowMs;
        } else {
          newCount = e.count + 1;
          newWindowStartIso = new Date(windowStartMs).toISOString();
          newExpiresAtMs = expiresMs;
        }
        const refillSec = Math.max(0, Math.floor((now - lastRefillMs) / 1000));
        const refilled = Math.min(
          BURST_TOKENS,
          Math.max(0, e.tokens_remaining) + refillSec * BURST_REFILL_PER_SEC,
        );
        newTokens = Math.max(-1, refilled - 1);
        newLastRefillIso = new Date(
          refillSec > 0 ? lastRefillMs + refillSec * 1000 : lastRefillMs,
        ).toISOString();
      }
      const newExpiresIso = new Date(newExpiresAtMs).toISOString();
      const rs = (await tx.execute(sql`
        INSERT INTO gateway_rate_limit_buckets (key, window_start, count, expires_at, tokens_remaining, last_refill_at)
        VALUES (${key}, ${newWindowStartIso}, ${newCount}, ${newExpiresIso}, ${newTokens}, ${newLastRefillIso})
        ON CONFLICT (key) DO UPDATE SET
          window_start    = EXCLUDED.window_start,
          count           = EXCLUDED.count,
          expires_at      = EXCLUDED.expires_at,
          tokens_remaining = EXCLUDED.tokens_remaining,
          last_refill_at  = EXCLUDED.last_refill_at
        RETURNING count, expires_at, tokens_remaining
      `)) as unknown as Array<{
        count: number;
        expires_at: string | Date;
        tokens_remaining: number;
      }>;
      return rs[0] ?? null;
    },
  );

  if (!row) {
    return {
      allowed: true,
      retryAfterSec: 0,
      limit: spec.perVisitorMax,
      windowSec: spec.windowSeconds,
      remaining: spec.perVisitorMax - 1,
    };
  }

  const expiresMs =
    row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at));
  const retryAfterMs = Math.max(0, expiresMs - Date.now());

  // Burst gate: tokens_remaining is the post-decrement value. Negative
  // means we burned through the bucket faster than refill — deny.
  if (row.tokens_remaining < 0) {
    return {
      allowed: false,
      retryAfterSec: 1,
      limit: spec.perVisitorMax,
      windowSec: spec.windowSeconds,
      remaining: Math.max(0, spec.perVisitorMax - row.count),
    };
  }

  // Sliding window gate.
  if (row.count > spec.perVisitorMax) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
      limit: spec.perVisitorMax,
      windowSec: spec.windowSeconds,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    retryAfterSec: 0,
    limit: spec.perVisitorMax,
    windowSec: spec.windowSeconds,
    remaining: spec.perVisitorMax - row.count,
  };
}

/**
 * The rate-limit key: the (plugin, operation) pair and the hash of the
 * client address the deployment's proxies vouch for.
 *
 * Why not the visitor cookie: a budget keyed by something the client
 * holds is one the client resets — drop the cookie (or never accept it)
 * and every request starts a fresh bucket. The address pins the bucket
 * whatever the cookie state. Real users behind a shared NAT are throttled
 * together, which is the usual trade-off.
 */
export function ipScopedRateLimitKey(
  pluginSlug: string,
  operation: string,
  ipHash: string,
): string {
  return `gateway-ip:${pluginSlug}:${operation}:${ipHash}`;
}
