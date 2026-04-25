// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo/query-api";
import { PostgresRateLimiter } from "../rate-limit.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let limiter: PostgresRateLimiter;

const TEST_KEY_PREFIX = "test-pgrl-";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  limiter = new PostgresRateLimiter(adapter, { windowMs: 60_000, limit: 3 });
});

afterAll(async () => {
  // Targeted cleanup so we don't blow away other suites' buckets.
  await adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM rate_limit_buckets WHERE key LIKE ${TEST_KEY_PREFIX + "%"}`;
  });
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
});
