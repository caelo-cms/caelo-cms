// SPDX-License-Identifier: MPL-2.0

/**
 * Migration 0636: the seeded Sonnet prices match Anthropic's list. Claude
 * Sonnet 5 stayed at $2/$10 (the increase scheduled for 2026-09-01 was
 * cancelled) and Claude Sonnet 5.5 cache hits are $0.10 per MTok.
 *
 * Do not run against the shared dev DB. CI runs it on the compose Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

let sqlc: SQL;

interface PriceRow {
  readonly input_microcents: string | number;
  readonly output_microcents: string | number;
  readonly cached_microcents: string | number;
  readonly cache_creation_microcents: string | number;
}

async function rates(model: string): Promise<PriceRow[]> {
  return sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    return (await tx`
      SELECT input_microcents, output_microcents, cached_microcents, cache_creation_microcents
      FROM ai_pricing
      WHERE provider = 'anthropic' AND model = ${model} AND operation_type = 'text'`) as PriceRow[];
  });
}

describe("seeded Sonnet list prices", () => {
  beforeAll(() => {
    sqlc = new SQL(ADMIN_URL);
  });
  afterAll(async () => {
    await sqlc.close();
  });

  it("no Sonnet 5 row carries the cancelled $3 / $15, the undated seed row included", async () => {
    const rows = await rates("claude-sonnet-5");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.input_microcents)).toBe(200000);
      expect(Number(row.output_microcents)).toBe(1000000);
      expect(Number(row.cached_microcents)).toBe(20000);
      expect(Number(row.cache_creation_microcents)).toBe(250000);
    }
  });

  it("Sonnet 5.5 cache hits cost half of Sonnet 5's", async () => {
    const rows = await rates("claude-sonnet-5-5");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.input_microcents)).toBe(200000);
      expect(Number(row.cached_microcents)).toBe(10000);
      expect(Number(row.cache_creation_microcents)).toBe(250000);
    }
  });
});
