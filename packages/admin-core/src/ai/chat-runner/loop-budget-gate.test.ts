// SPDX-License-Identifier: MPL-2.0

/**
 * issue #297 — the tool loop's LIVE cost gate.
 *
 *   - spend ≥ ceiling at iteration start → the loop makes NO provider call,
 *     persists the pause message, and ends the turn with
 *     `stopReason: "cost_ceiling"` (clean + resumable, not an error).
 *   - spend ≥ 80% → ONE system-origin warning is persisted (claim-gated)
 *     and the loop keeps running.
 *   - no gate (session not tied to a ceilinged run) → zero interference.
 *
 * Same stub style as loop-toolcall-pairing.test.ts: provider + Query API
 * are fixtures; this exercises the loop's gate control-flow only. The gate
 * ops' SQL is covered by import-cost-gate.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { AIProvider, GenerateInput, ProviderEvent } from "../provider.js";
import type { ToolRegistry } from "../tools/index.js";
import type { BudgetGateState } from "./budget-gate.js";
import { runToolLoop, type ToolLoopResult } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

const USD = 100_000_000; // microcents per $1

function gateFixture(spentMicrocents: number): BudgetGateState {
  return {
    runId: "00000000-0000-4000-8000-000000000297",
    ceilingMicrocents: 4.2 * USD,
    ceilingCurrency: "USD",
    spentMicrocents,
    callCount: 10,
    unpricedCallCount: 0,
    estimateLowUsd: 0.28,
    estimateHighUsd: 1.4,
    warningEmitted: false,
    tripped: false,
  };
}

/** One text-only turn; records whether the provider was called at all. */
class OneTurnProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-budget-gate";
  calls = 0;
  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.calls++;
    yield { kind: "text-delta", text: "working" };
    yield { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

interface AppendedMessage {
  role: string;
  content: string;
  origin: string | null;
}

function buildFixtureQueryApi(gate: BudgetGateState | null): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  appended: AppendedMessage[];
  gateEvents: { kind: string }[];
} {
  const appended: AppendedMessage[] = [];
  const gateEvents: { kind: string }[] = [];
  const claimedKinds = new Set<string>();
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "chat.append_message",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ role: z.string(), content: z.string() }),
      output: z.looseObject({}),
      handler: async (_ctx, input) => {
        appended.push({
          role: input.role,
          content: input.content,
          origin: (input.origin as string | undefined) ?? null,
        });
        return ok({ messageId: `msg-${appended.length}` });
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "imports.get_session_budget_state",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({ gate }),
    }),
  );
  registry.register(
    defineOperation({
      name: "imports.record_budget_gate_event",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.looseObject({ kind: z.string() }),
      output: z.looseObject({}),
      handler: async (_ctx, input) => {
        gateEvents.push({ kind: input.kind });
        // Real op semantics: each kind claims exactly once until re-armed.
        if (claimedKinds.has(input.kind)) return ok({ claimed: false });
        claimedKinds.add(input.kind);
        return ok({ claimed: true });
      },
    }),
  );
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter, appended, gateEvents };
}

async function runLoop(
  provider: AIProvider,
  fixture: ReturnType<typeof buildFixtureQueryApi>,
): Promise<{ events: ClientEvent[]; result: ToolLoopResult }> {
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools: {
      dispatch: async () => ({ ok: true, content: "unused" }),
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-budget-gate",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [],
    initialMessages: [{ role: "user", content: "continue the migration" }],
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
    maxOutputTokens: 16384,
    temperature: undefined,
    thinkingBudget: null,
    usage,
    costCapMicrocents: undefined,
    inputCost: 15,
    outputCost: 75,
  });
  const events: ClientEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe("runToolLoop — live budget gate (#297)", () => {
  it("pauses BEFORE any provider call when spend has reached the ceiling", async () => {
    const provider = new OneTurnProvider();
    const fixture = buildFixtureQueryApi(gateFixture(4.2 * USD)); // exactly at ceiling
    const { events, result } = await runLoop(provider, fixture);

    // No provider spend past the ceiling — the pause happens first.
    expect(provider.calls).toBe(0);
    expect(result.stopReason).toBe("cost_ceiling");
    // Clean pause, not an error: resumable after re-arming.
    expect(result.succeeded).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false);

    const pause = fixture.appended.find((m) => m.role === "assistant");
    expect(pause?.content).toContain("Cost ceiling reached");
    expect(pause?.content).toContain("$4.20");
    // The trip landed in the run ledger.
    expect(fixture.gateEvents.map((e) => e.kind)).toContain("tripped");
    // No stacked "tool-loop limit" notice on top of the pause message.
    expect(fixture.appended.filter((m) => m.content.includes("tool-loop limit"))).toHaveLength(0);
  });

  it("emits ONE system-origin warning at >=80% and lets the turn proceed", async () => {
    const provider = new OneTurnProvider();
    const fixture = buildFixtureQueryApi(gateFixture(3.5 * USD)); // ~83%
    const { result } = await runLoop(provider, fixture);

    expect(provider.calls).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    const warnings = fixture.appended.filter(
      (m) => m.role === "user" && m.content.includes("Budget notice"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.origin).toBe("system");
    expect(fixture.gateEvents.map((e) => e.kind)).toEqual(["warning"]);
  });

  it("stays out of the way when the session has no gate", async () => {
    const provider = new OneTurnProvider();
    const fixture = buildFixtureQueryApi(null);
    const { result } = await runLoop(provider, fixture);

    expect(provider.calls).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(fixture.gateEvents).toHaveLength(0);
  });
});
