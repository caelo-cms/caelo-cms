// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo/query-api";
import { PostgresRateLimiter } from "../rate-limit.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let limiter: PostgresRateLimiter;

const TEST_KEY_PREFIX = "test-pgrl-";

async function wipeTestBuckets(): Promise<void> {
  await adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM rate_limit_buckets WHERE key LIKE ${TEST_KEY_PREFIX + "%"}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  limiter = new PostgresRateLimiter(adapter, { windowMs: 60_000, limit: 3 });
  // Defensive: a prior killed run could have left buckets behind that
  // would otherwise tip the very first consume into the upsert's
  // conflict branch with stale counters.
  await wipeTestBuckets();
});

beforeEach(async () => {
  // Make every test independent — no carryover from sibling tests in
  // the same file or from interleaved combined-load runs.
  await wipeTestBuckets();
});

afterAll(async () => {
  await wipeTestBuckets();
  await adapter.close();
});

describe("PostgresRateLimiter", () => {
  it("allows up to the limit, rejects after", async () => {
    const key = `${TEST_KEY_PREFIX}counted`;
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(true);
    const fourth = await limiter.consume(key);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates buckets per key", async () => {
    const a = `${TEST_KEY_PREFIX}iso-a`;
    const b = `${TEST_KEY_PREFIX}iso-b`;
    expect((await limiter.consume(a)).allowed).toBe(true);
    expect((await limiter.consume(a)).allowed).toBe(true);
    expect((await limiter.consume(a)).allowed).toBe(true);
    expect((await limiter.consume(a)).allowed).toBe(false);
    // b should still have a fresh window.
    expect((await limiter.consume(b)).allowed).toBe(true);
  });

  it("resets count + window when the existing bucket has already expired", async () => {
    // Regression for the upsert flake: pre-seed a stale row mimicking
    // what a killed-mid-run prior test would leave behind. The next
    // consume must treat it as a fresh window — not increment count
    // against a past expires_at.
    const key = `${TEST_KEY_PREFIX}expired-conflict`;
    await adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
        VALUES (${key}, now() - interval '2 minutes', 5, now() - interval '30 seconds')
      `;
    });
    const first = await limiter.consume(key);
    expect(first.allowed).toBe(true);
    expect(first.retryAfterMs).toBe(0);
    // And the window is fresh — three more consumes pass before the limit kicks in.
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(true);
    const fourth = await limiter.consume(key);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });
});
