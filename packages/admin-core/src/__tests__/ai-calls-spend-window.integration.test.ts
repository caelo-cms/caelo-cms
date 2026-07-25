// SPDX-License-Identifier: MPL-2.0

/**
 * ai_calls.spend_window — lightweight windowed spend total for the admin
 * top-bar readout. Asserts the SUM includes rows inside the window and
 * EXCLUDES rows older than it. Uses a before/after delta so other rows
 * already in the shared dev DB don't affect the assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "spend-window-test",
};

const TEST_PROVIDER = "anthropic-spend-window-test";

const IN_WINDOW_COST = 700_000;
const OLD_COST = 999_000_000;

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

/** Insert an ai_calls row backdated by `daysAgo` (raw SQL — the op always
 * stamps created_at = now(), so we can't backdate through it). Reuses the
 * system actor the record_ai_call path relies on to satisfy the FK. */
async function seedBackdated(costMicrocents: number, daysAgo: number): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO ai_calls (
          actor_id, provider, model, input_tokens, output_tokens,
          cost_estimate_microcents, created_at
        ) VALUES (
          ${HUMAN.actorId}::uuid, ${TEST_PROVIDER}, 'claude-sw-1', 10, 10,
          ${costMicrocents}::bigint, now() - make_interval(days => ${daysAgo})
        )`;
    });
  } finally {
    await sql.end();
  }
}

async function spendWindow(days: number): Promise<{ costMicrocents: number; days: number }> {
  const r = await execute(registry, adapter, HUMAN, "ai_calls.spend_window", { days });
  if (!r.ok) throw new Error(`spend_window failed: ${JSON.stringify(r.error)}`);
  return r.value as { costMicrocents: number; days: number };
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

describe("ai_calls.spend_window", () => {
  it("sums only rows inside the window, excluding older ones", async () => {
    const baseline = await spendWindow(7);
    expect(baseline.days).toBe(7);

    // A row 1 day ago is inside the 7-day window → counted.
    await seedBackdated(IN_WINDOW_COST, 1);
    const afterIn = await spendWindow(7);
    expect(afterIn.costMicrocents - baseline.costMicrocents).toBe(IN_WINDOW_COST);

    // A row 10 days ago is OUTSIDE the 7-day window → not counted.
    await seedBackdated(OLD_COST, 10);
    const afterOld = await spendWindow(7);
    expect(afterOld.costMicrocents).toBe(afterIn.costMicrocents);

    // Widening the window to 30 days now includes the old row.
    const wide = await spendWindow(30);
    expect(wide.costMicrocents - afterOld.costMicrocents).toBe(OLD_COST);
    expect(wide.days).toBe(30);
  });
});
