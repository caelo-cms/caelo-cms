// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — gateway rate limiter.
 *
 * Wraps the existing PostgresRateLimiter with per-(plugin, operation)
 * limits resolved from:
 *   1. `plugin_rate_limit_overrides` row (Owner-set or §11.A approved)
 *   2. plugin manifest's `gateway.rateLimits[op]`
 *   3. default fallback (30 req / 60s)
 *
 * Key: `gateway:${pluginSlug}:${operation}:${visitorId}`
 *
 * Token-bucket overlay (10 tokens, refill 1/s) lives in the same row's
 * `tokens_remaining` + `last_refill_at` columns; a single tx checks the
 * sliding window AND the burst tokens — one round-trip per request.
 */

import type { LoadedPlugin } from "@caelo/plugin-host";
import type { DatabaseAdapter } from "@caelo/query-api";
import { sql } from "drizzle-orm";

export interface RateLimitSpec {
  readonly perVisitorMax: number;
  readonly windowSeconds: number;
}

const DEFAULT_SPEC: RateLimitSpec = { perVisitorMax: 30, windowSeconds: 60 };
const BURST_TOKENS = 10;
const BURST_REFILL_PER_SEC = 1;

// P13 audit re-pass — cache spec lookups for 5s. Most public POSTs hit
// plugins with no override row; without this cache we burn one DB
// roundtrip per request just to find out. Cleared on `pg_notify(
// 'caelo_gateway_settings', …)` via invalidateRateLimitSpecCache().
const SPEC_TTL_MS = 5_000;
const specCache = new Map<string, { spec: RateLimitSpec; loadedAt: number }>();

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
  profile_name: string | null;
  profile_per_visitor_max: number | null;
  profile_window_seconds: number | null;
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
  if (cached && Date.now() - cached.loadedAt < SPEC_TTL_MS) {
    return cached.spec;
  }
  // 1. Check overrides table.
  const rows = await adapter.withAdminTransaction(
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "rl-resolve",
    },
    async (tx) =>
      (await tx.execute(sql`
        SELECT
          o.per_visitor_max,
          o.window_seconds,
          o.profile_name,
          p.per_visitor_max AS profile_per_visitor_max,
          p.window_seconds  AS profile_window_seconds
        FROM plugin_rate_limit_overrides o
        LEFT JOIN rate_limit_profiles p ON p.name = o.profile_name
        WHERE o.plugin_slug = ${pluginSlug} AND o.operation = ${operation}
        LIMIT 1
      `)) as unknown as OverrideRow[],
  );
  let resolved: RateLimitSpec;
  if (rows[0]) {
    // P13 ideas-pass — profile dereferences first; row's per/window
    // is the fallback when no profile is named.
    if (
      rows[0].profile_name &&
      rows[0].profile_per_visitor_max !== null &&
      rows[0].profile_window_seconds !== null
    ) {
      resolved = {
        perVisitorMax: rows[0].profile_per_visitor_max,
        windowSeconds: rows[0].profile_window_seconds,
      };
    } else {
      resolved = {
        perVisitorMax: rows[0].per_visitor_max,
        windowSeconds: rows[0].window_seconds,
      };
    }
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
  specCache.set(cacheKey, { spec: resolved, loadedAt: Date.now() });
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

  const row = await adapter.withAdminTransaction(
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
        FROM rate_limit_buckets
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
      const e = existing[0];
      let newCount: number;
      let newExpiresAtMs: number;
      let newTokens: number;
      if (!e) {
        newCount = 1;
        newExpiresAtMs = now + windowMs;
        newTokens = BURST_TOKENS - 1;
      } else {
        const expiresMs =
          e.expires_at instanceof Date ? e.expires_at.getTime() : Date.parse(String(e.expires_at));
        const lastRefillMs =
          e.last_refill_at instanceof Date
            ? e.last_refill_at.getTime()
            : Date.parse(String(e.last_refill_at));
        if (expiresMs < now) {
          newCount = 1;
          newExpiresAtMs = now + windowMs;
        } else {
          newCount = e.count + 1;
          newExpiresAtMs = expiresMs;
        }
        const refillSec = Math.max(0, Math.floor((now - lastRefillMs) / 1000));
        const refilled = Math.min(
          BURST_TOKENS - 1,
          e.tokens_remaining + refillSec * BURST_REFILL_PER_SEC,
        );
        newTokens = refilled - 1;
      }
      const newExpiresIso = new Date(newExpiresAtMs).toISOString();
      const nowIso = new Date(now).toISOString();
      const rs = (await tx.execute(sql`
        INSERT INTO rate_limit_buckets (key, window_start, count, expires_at, tokens_remaining, last_refill_at)
        VALUES (${key}, ${nowIso}, ${newCount}, ${newExpiresIso}, ${newTokens}, ${nowIso})
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

export function rateLimitKey(pluginSlug: string, operation: string, visitorId: string): string {
  return `gateway:${pluginSlug}:${operation}:${visitorId}`;
}

/**
 * P13 audit re-pass — IP-hash rate-limit key.
 *
 * When a visitor presents no signed cookie (fresh visitor OR honeypot
 * branch where we deliberately don't mint one), the bare visitorId
 * is a fresh UUID per request — meaning every bot retry creates a new
 * `rate_limit_buckets` row + escapes per-visitor throttling. Hashing
 * the request's source IP and combining it with the slug pins the
 * bucket to the (origin, op) pair regardless of cookie state, so a
 * bot can't multiply rows by spinning fresh uuids.
 *
 * Real users behind shared NAT are throttled together, which is the
 * usual + correct trade-off for honeypot / pre-cookie traffic. Once
 * a visitor has a signed cookie we revert to the per-visitor key
 * (fairer rate budgets for legit traffic).
 */
export function ipScopedRateLimitKey(
  pluginSlug: string,
  operation: string,
  ipHash: string,
): string {
  return `gateway-ip:${pluginSlug}:${operation}:${ipHash}`;
}
