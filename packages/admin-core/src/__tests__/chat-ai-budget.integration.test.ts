// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — a chat turn inside the AI spend ledger, through the real
 * chat-runner and a scripted provider:
 *
 * - without a budget the turn runs and its one `ai_calls` row is settled to
 *   the real usage of all its steps;
 * - a reached day-global text budget stops the turn before its first
 *   request (the provider is never called) with a notice that says why;
 * - when other spend fills the budget during the turn (a parallel chat, a
 *   subagent), the next step is refused before it goes out, and the steps
 *   that ran stay billed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, resetCapLookupCounters } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import type { ClientEvent } from "../ai/chat-runner.js";
import { runChatTurn } from "../ai/chat-runner.js";
import { invalidateAllPricing } from "../ai/pricing-cache.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1653-chat",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1653-chat-ai",
};
const MODEL = "t1653-chat-model";
const TITLE = "t1653-budget-%";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${TITLE})`;
    await tx`DELETE FROM ai_calls WHERE model = ${MODEL} OR provider = 't1653-elsewhere'`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${TITLE}`;
    await tx`UPDATE ai_budgets SET cap_microcents = NULL WHERE operation_type = 'text'`;
  });
}

async function setGlobalTextCap(cap: number | null): Promise<void> {
  await withSql(
    (tx) => tx`
      INSERT INTO ai_budgets (scope, operation_type, cap_microcents, warn_at_pct, updated_at)
      VALUES ('day-global', 'text', ${cap}, 0.8, now())
      ON CONFLICT (scope, operation_type) DO UPDATE SET cap_microcents = EXCLUDED.cap_microcents
    `,
  );
}

/** Step 1 calls `spend_elsewhere`, step 2 answers. */
class TwoSteps extends FixtureProvider {
  steps = 0;
  constructor() {
    super([], MODEL);
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.steps += 1;
    if (this.steps === 1) {
      return [
        { kind: "tool-call", id: "c1", name: "spend_elsewhere", arguments: {} },
        { kind: "usage", inputTokens: 5, outputTokens: 4, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "Done." },
      { kind: "usage", inputTokens: 3, outputTokens: 2, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

/** `spend_elsewhere` books `amount` of other spend (a parallel chat) while the turn runs. */
function tools(amount: { value: number }): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "spend_elsewhere",
    description: "another chat spends meanwhile",
    schema: z.object({}),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      if (amount.value > 0) {
        await withSql(
          (tx) => tx`
            INSERT INTO ai_calls (actor_id, provider, model, input_tokens, output_tokens,
                                  cost_estimate_microcents, operation_type)
            VALUES (${AI.actorId}::uuid, 't1653-elsewhere', 'other', 0, 0, ${amount.value}, 'text')
          `,
        );
      }
      return { ok: true, content: "spent" };
    },
  });
  return r;
}

async function turn(provider: TwoSteps, amount: number) {
  const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
    title: `t1653-budget-${crypto.randomUUID().slice(0, 6)}`,
  });
  if (!session.ok) throw new Error(JSON.stringify(session.error));
  const chatSessionId = (session.value as { chatSessionId: string }).chatSessionId;
  const events: ClientEvent[] = [];
  for await (const ev of runChatTurn(
    { adapter, registry, provider, tools: tools({ value: amount }), aiCtx: AI, humanCtx: HUMAN },
    { chatSessionId, content: "do the thing", chips: [] },
  )) {
    events.push(ev);
  }
  const rows = await withSql(
    (tx) => tx`
      SELECT reservation, cost_estimate_microcents::int AS cost, input_tokens, output_tokens
      FROM ai_calls WHERE chat_session_id = ${chatSessionId}::uuid AND model = ${MODEL}
    `,
  );
  const text = events
    .filter((e) => e.kind === "text-delta")
    .map((e) => (e as { text: string }).text)
    .join("");
  return {
    rows: rows as unknown as {
      reservation: string;
      cost: number;
      input_tokens: number;
      output_tokens: number;
    }[],
    text,
  };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  await withSql(
    (tx) => tx`
      INSERT INTO ai_pricing (provider, model, operation_type, input_microcents, output_microcents,
                              cached_microcents, cache_creation_microcents)
      VALUES ('anthropic', ${MODEL}, 'text', 2000, 5000, 200, 5000)
      ON CONFLICT DO NOTHING
    `,
  );
  invalidateAllPricing();
});

beforeEach(async () => {
  resetCapLookupCounters();
  await wipe();
});

afterAll(async () => {
  await wipe();
  await withSql((tx) => tx`DELETE FROM ai_pricing WHERE model = ${MODEL}`);
  await adapter.close();
});

describe("a chat turn inside the AI spend ledger (#1653)", () => {
  it("without a budget the turn runs and its row is settled to the real usage", async () => {
    const provider = new TwoSteps();
    const r = await turn(provider, 0);
    expect(provider.steps).toBe(2);
    // (5 + 3) input × 2,000/1K + (4 + 2) output × 5,000/1K = 16 + 30 = 46.
    expect(r.rows).toEqual([
      { reservation: "settled", cost: 46, input_tokens: 8, output_tokens: 6 },
    ]);
  });

  it("a reached budget stops the turn before its first request", async () => {
    await setGlobalTextCap(1);
    const provider = new TwoSteps();
    const r = await turn(provider, 0);
    expect(provider.steps).toBe(0);
    expect(r.text).toContain("daily AI text budget is reached");
    expect(r.text).toContain("Settings → AI → Budgets");
    expect(r.rows).toEqual([]);
  });

  it("spend elsewhere that fills the budget mid-turn refuses the next step; the first stays billed", async () => {
    await setGlobalTextCap(50_000_000);
    const provider = new TwoSteps();
    const r = await turn(provider, 50_000_000);
    expect(provider.steps).toBe(1);
    expect(r.text).toContain("daily AI text budget is reached");
    // Step 1 only: 5 × 2 + 4 × 5 = 30.
    expect(r.rows).toEqual([
      { reservation: "settled", cost: 30, input_tokens: 5, output_tokens: 4 },
    ]);
  });
});
