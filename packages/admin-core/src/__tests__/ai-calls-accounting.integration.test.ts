// SPDX-License-Identifier: MPL-2.0

/**
 * ai_calls accounting + dashboard aggregation:
 *   - chat.record_ai_call inserts a row with the provided token counts.
 *   - ai_calls.aggregate sums totals + groups per day; cost converts
 *     correctly from microcents to USD.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p5-acc",
};

const TEST_PROVIDER = "anthropic-acc-test";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM ai_calls WHERE provider = ${TEST_PROVIDER}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("ai_calls accounting", () => {
  it("record_ai_call writes a row; aggregate sums correctly", async () => {
    // 100 input + 50 output @ ($15 + $75 / M) = 100*15/1e6 + 50*75/1e6
    //   = 0.0015 + 0.00375 = 0.00525 USD = 525_000 microcents.
    const r1 = await execute(registry, adapter, HUMAN, "chat.record_ai_call", {
      provider: TEST_PROVIDER,
      model: "claude-acc-1",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      costEstimateMicrocents: 525_000,
      durationMs: 250,
      succeeded: true,
    });
    expect(r1.ok).toBe(true);

    const r2 = await execute(registry, adapter, HUMAN, "chat.record_ai_call", {
      provider: TEST_PROVIDER,
      model: "claude-acc-1",
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 0,
      costEstimateMicrocents: 900_000,
      durationMs: 300,
      succeeded: true,
    });
    expect(r2.ok).toBe(true);

    const agg = await execute(registry, adapter, HUMAN, "ai_calls.aggregate", {});
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;
    const totals = (
      agg.value as {
        totals: {
          calls: number;
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          costUsd: number;
        };
      }
    ).totals;
    expect(totals.calls).toBeGreaterThanOrEqual(2);
    expect(totals.inputTokens).toBeGreaterThanOrEqual(300);
    expect(totals.outputTokens).toBeGreaterThanOrEqual(130);
    // Microcents / 1e8 = USD; both rows together = 1_425_000 / 1e8 = 0.01425
    expect(totals.costUsd).toBeGreaterThan(0.014);
  });

  it("perDay groups by date with non-zero rows", async () => {
    const agg = await execute(registry, adapter, HUMAN, "ai_calls.aggregate", {});
    if (!agg.ok) return;
    const perDay = (agg.value as { perDay: { day: string; calls: number; costUsd: number }[] })
      .perDay;
    expect(perDay.length).toBeGreaterThan(0);
    expect(perDay[0]?.calls).toBeGreaterThan(0);
  });
});
