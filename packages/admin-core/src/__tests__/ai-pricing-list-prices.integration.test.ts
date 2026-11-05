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
}

async function currentRate(model: string): Promise<PriceRow | undefined> {
  return sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const rows = (await tx`
      SELECT input_microcents, output_microcents, cached_microcents
      FROM ai_pricing
      WHERE provider = 'anthropic' AND model = ${model} AND operation_type = 'text'
      ORDER BY effective_from DESC
      LIMIT 1`) as PriceRow[];
    return rows[0];
  });
}

describe("seeded Sonnet list prices", () => {
  beforeAll(() => {
    sqlc = new SQL(ADMIN_URL);
  });
  afterAll(async () => {
    await sqlc.close();
  });

  it("Sonnet 5 stays at $2 / $10 after the cancelled increase", async () => {
    const rate = await currentRate("claude-sonnet-5");
    expect(Number(rate?.input_microcents)).toBe(200000);
    expect(Number(rate?.output_microcents)).toBe(1000000);
    expect(Number(rate?.cached_microcents)).toBe(20000);
  });

  it("Sonnet 5.5 cache hits cost half of Sonnet 5's", async () => {
    const rate = await currentRate("claude-sonnet-5-5");
    expect(Number(rate?.input_microcents)).toBe(200000);
    expect(Number(rate?.cached_microcents)).toBe(10000);
  });
});
