// SPDX-License-Identifier: MPL-2.0

/**
 * Same-tool runaway guard (replaces the old flat 25-iteration cap).
 *
 *   - SAME single tool called on SAME_TOOL_RUNAWAY_LIMIT consecutive
 *     iterations → the loop stops with `stopReason: "same_tool_runaway"` and a
 *     message naming the stuck tool (a stuck retry loop).
 *   - VARIED tool sequences never trip the guard: they run until the model
 *     stops, the budget gate pauses them, or the absolute ceiling backstop
 *     (ABSOLUTE_LOOP_CEILING) is reached.
 *   - A single iteration emitting MULTIPLE DIFFERENT tools resets the streak
 *     (varied work is not a runaway).
 *
 * Same stub style as loop-budget-gate.test.ts: provider + Query API are
 * fixtures; this exercises the loop's runaway control-flow only.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { AIProvider, ProviderEvent } from "../provider.js";
import { FixtureProvider } from "../providers/anthropic.js";
import type { ToolRegistry } from "../tools/index.js";
import { runToolLoop, SAME_TOOL_RUNAWAY_LIMIT, type ToolLoopResult } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/**
 * issue #442 — per-STEP scripting over the real SDK loop: `script(call)`
 * returns the model step's events; `calls` counts model steps (the pre-#442
 * per-provider-call semantics map 1:1 onto steps).
 */
class ScriptedStepsProvider extends FixtureProvider {
  calls = 0;
  readonly #script: (call: number) => ProviderEvent[];
  constructor(script: (call: number) => ProviderEvent[]) {
    super([]);
    this.#script = script;
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.calls++;
    return this.#script(this.calls);
  }
}

/** Emits the SAME tool name on every step — the stuck retry-loop shape. */
function stuckToolProvider(toolName = "build_page"): ScriptedStepsProvider {
  return new ScriptedStepsProvider((call) => [
    { kind: "tool-call", id: `toolu_${call}`, name: toolName, arguments: {} },
    { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    { kind: "done", stopReason: "tool_use" },
  ]);
}

/**
 * Emits a DIFFERENT tool name every turn (cycling), so no single name ever
 * repeats on consecutive iterations. Ends the turn cleanly after `stopAfter`
 * calls (model-stop), the way a productive migration eventually does.
 */
function variedToolProvider(stopAfter: number): ScriptedStepsProvider {
  return new ScriptedStepsProvider((call) => {
    if (call > stopAfter) {
      return [
        { kind: "text-delta", text: "all done" },
        { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ];
    }
    // Cycle through 4 distinct names so consecutive steps always differ.
    return [
      { kind: "tool-call", id: `toolu_${call}`, name: `tool_${call % 4}`, arguments: {} },
      { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ];
  });
}

/** Emits a DIFFERENT tool every turn and NEVER stops — bounded only by the
 *  absolute ceiling (maxLoops). Verifies varied work isn't caught by the
 *  same-tool guard; it falls through to the ceiling backstop instead. */
function endlessVariedProvider(): ScriptedStepsProvider {
  return new ScriptedStepsProvider((call) => [
    { kind: "tool-call", id: `toolu_${call}`, name: `tool_${call % 4}`, arguments: {} },
    { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    { kind: "done", stopReason: "tool_use" },
  ]);
}

/** Emits TWO different tools in ONE iteration, repeatedly — a mixed set, which
 *  must reset the streak and never trip the guard. Stops after `stopAfter`. */
function mixedSetProvider(stopAfter: number): ScriptedStepsProvider {
  return new ScriptedStepsProvider((call) => {
    if (call > stopAfter) {
      return [
        { kind: "text-delta", text: "all done" },
        { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ];
    }
    return [
      { kind: "tool-call", id: `toolu_a_${call}`, name: "tool_a", arguments: {} },
      { kind: "tool-call", id: `toolu_b_${call}`, name: "tool_b", arguments: {} },
      { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ];
  });
}

interface AppendedMessage {
  role: string;
  content: string;
}

function buildFixtureQueryApi(): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  appended: AppendedMessage[];
} {
  const appended: AppendedMessage[] = [];
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "chat.append_message",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ role: z.string(), content: z.string() }),
      output: z.looseObject({}),
      handler: async (_ctx, input) => {
        appended.push({ role: input.role, content: input.content });
        return ok({ messageId: `msg-${appended.length}` });
      },
    }),
  );
  // No cost gate for these tests — the loop reads this once at loop 0.
  registry.register(
    defineOperation({
      name: "imports.get_session_budget_state",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({ gate: null }),
    }),
  );
  // Tool-dispatch dedup cache (always a miss) so every tool call dispatches +
  // persists its own tool_result.
  registry.register(
    defineOperation({
      name: "chat.lookup_tool_result",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({ cached: null }),
    }),
  );
  registry.register(
    defineOperation({
      name: "chat.set_response_messages",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({ updated: true }),
    }),
  );
  registry.register(
    defineOperation({
      name: "chat.cache_tool_result",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({}),
    }),
  );
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter, appended };
}

async function runLoop(
  provider: AIProvider,
  fixture: ReturnType<typeof buildFixtureQueryApi>,
  maxLoops: number,
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
    chatSessionId: "cs-same-tool",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    // Every scripted tool name ships a schema so the SDK loop executes it
    // through the dispatch wrapper (an unknown tool would be dropped).
    filteredTools: ["build_page", "tool_0", "tool_1", "tool_2", "tool_3", "tool_a", "tool_b"].map(
      (name) => ({ name, description: `fixture tool ${name}`, inputSchema: { type: "object" } }),
    ),
    initialMessages: [{ role: "user", content: "continue the migration" }],
    compactionThresholdTokens: 600_000,
    maxLoops,
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

describe("runToolLoop — same-tool runaway guard", () => {
  it("stops when the SAME tool is called SAME_TOOL_RUNAWAY_LIMIT times in a row", async () => {
    const provider = stuckToolProvider("build_page");
    const fixture = buildFixtureQueryApi();
    // maxLoops well above the runaway limit so the guard — not the ceiling — fires.
    const { result } = await runLoop(provider, fixture, 200);

    expect(result.stopReason).toBe("same_tool_runaway");
    expect(result.succeeded).toBe(true);
    // Exactly SAME_TOOL_RUNAWAY_LIMIT provider calls — the guard trips on the
    // iteration whose streak reaches the limit, no more.
    expect(provider.calls).toBe(SAME_TOOL_RUNAWAY_LIMIT);

    // The pause message names the stuck tool and the count, and is
    // user-actionable (invites "continue"); no generic "tool-loop limit"
    // notice stacked on top.
    const runaway = fixture.appended.find(
      (m) => m.role === "assistant" && m.content.includes("without making progress"),
    );
    expect(runaway).toBeDefined();
    expect(runaway?.content).toContain("`build_page`");
    expect(runaway?.content).toContain(`${SAME_TOOL_RUNAWAY_LIMIT} times in a row`);
    expect(runaway?.content).toContain('"continue"');
    expect(fixture.appended.filter((m) => m.content.includes("tool-loop limit"))).toHaveLength(0);
  });

  it("does NOT trip on a long VARIED tool sequence — runs to model-stop", async () => {
    const provider = variedToolProvider(30); // 30 varied tool steps, then end_turn
    const fixture = buildFixtureQueryApi();
    const { result } = await runLoop(provider, fixture, 200);

    // Ran all 30 varied iterations + the final end_turn call, unimpeded.
    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);
    expect(provider.calls).toBe(31);
    // Never surfaced a runaway or a loop-limit notice.
    expect(
      fixture.appended.filter((m) => m.content.includes("without making progress")),
    ).toHaveLength(0);
    expect(fixture.appended.filter((m) => m.content.includes("tool-loop limit"))).toHaveLength(0);
  });

  it("bounds endless VARIED work by the absolute ceiling, not the runaway guard", async () => {
    const provider = endlessVariedProvider();
    const fixture = buildFixtureQueryApi();
    // Small ceiling stands in for ABSOLUTE_LOOP_CEILING to keep the test fast.
    const { result } = await runLoop(provider, fixture, 15);

    expect(result.stopReason).toBe("max_loops");
    expect(provider.calls).toBe(15);
    // The backstop message, NOT the runaway message.
    expect(
      fixture.appended.filter((m) => m.content.includes("without making progress")),
    ).toHaveLength(0);
    const backstop = fixture.appended.find((m) => m.content.includes("tool-loop limit"));
    expect(backstop?.content).toContain("(15 iterations)");
    // User-actionable: the backstop invites "continue" too, never a dead end.
    expect(backstop?.content).toContain('"continue"');
  });

  it("resets the streak when one iteration emits MULTIPLE different tools", async () => {
    // 12 iterations, each emitting tool_a + tool_b together — a mixed set that
    // resets the streak every iteration, so it never trips despite exceeding
    // SAME_TOOL_RUNAWAY_LIMIT iterations.
    const provider = mixedSetProvider(12);
    const fixture = buildFixtureQueryApi();
    const { result } = await runLoop(provider, fixture, 200);

    expect(result.stopReason).toBe("end_turn");
    expect(provider.calls).toBe(13);
    expect(
      fixture.appended.filter((m) => m.content.includes("without making progress")),
    ).toHaveLength(0);
  });
});
