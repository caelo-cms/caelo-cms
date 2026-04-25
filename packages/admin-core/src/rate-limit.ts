// SPDX-License-Identifier: MPL-2.0

import type { DatabaseAdapter } from "@caelo/query-api";

/**
 * Postgres-backed sliding-window rate limiter. Buckets live in the
 * `rate_limit_buckets` table so all admin replicas share a single window per
 * key. Same `consume` API as the in-memory limiter from P2.1; the in-memory
 * variant stays for tests / dev where Postgres is overkill.
 *
 * Implementation: an upsert + conditional-increment. Atomic — no
 * read-modify-write race even under concurrent callers from multiple replicas.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export class PostgresRateLimiter {
  readonly #adapter: DatabaseAdapter;
  readonly #windowMs: number;
  readonly #limit: number;

  constructor(adapter: DatabaseAdapter, options: { windowMs: number; limit: number }) {
    this.#adapter = adapter;
    this.#windowMs = options.windowMs;
    this.#limit = options.limit;
  }

  async consume(key: string): Promise<RateLimitDecision> {
    const windowMs = this.#windowMs;
    const limit = this.#limit;

    const rows = (await this.#adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM rate_limit_buckets WHERE expires_at < now()`;

      const result = (await tx`
        INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
        VALUES (${key}, now(), 1, now() + (${windowMs} || ' milliseconds')::interval)
        ON CONFLICT (key) DO UPDATE
          SET count = rate_limit_buckets.count + 1
        RETURNING count, expires_at
      `) as unknown as { count: number; expires_at: Date }[];
      return result;
    })) as unknown as { count: number; expires_at: Date }[];

    const row = rows[0];
    if (!row) return { allowed: true, retryAfterMs: 0 };

    if (row.count <= limit) return { allowed: true, retryAfterMs: 0 };
    const expiresMs =
      row.expires_at instanceof Date
        ? row.expires_at.getTime()
        : Date.parse(String(row.expires_at));
    return { allowed: false, retryAfterMs: Math.max(0, expiresMs - Date.now()) };
  }

  async reset(): Promise<void> {
    await this.#adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM rate_limit_buckets`;
    });
  }
}
