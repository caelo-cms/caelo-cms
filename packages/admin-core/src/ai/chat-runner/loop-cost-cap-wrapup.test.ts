// SPDX-License-Identifier: MPL-2.0

/**
 * issue #304 — the per-child cost-cap WRAP-UP nudge in the tool loop.
 *
 * A subagent child turn carries `costCapMicrocents` (resolved by the
 * spawn orchestrator from the run budget). When the turn's billable
 * spend crosses ≥85% of that cap, the loop injects ONE system-origin
 * instruction to finish the current work item and submit a partial
 * result — the hook that turns "child errors at 100%, work discarded"
 * (runs #14/#15) into the #304 partial-completion contract.
 *
 * Same stub style as loop-budget-gate.test.ts: provider + Query API are
 * fixtures; this exercises the loop's nudge control-flow only.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { AIProvider, GenerateInput, ProviderEvent } from "../provider.js";
import type { ToolRegistry } from "../tools/index.js";
import { runToolLoop, type ToolLoopResult } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/**
 * Turn 1: a tool call + heavy usage (so the loop iterates again with the
 * spend already booked). Turn 2: plain end_turn. inputCost is 15 $/MTok
 * in the harness, so 1M input tokens ≈ $15 ≈ 1.5e9 µ¢ of billable spend.
 */
class TwoTurnToolProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-cap-wrapup";
  calls = 0;
  /** messages snapshot per generate() call, for asserting the nudge reached the model. */
  seenMessages: string[][] = [];

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.calls++;
    this.seenMessages.push(input.messages.map((m) => m.content));
    if (this.calls === 1) {
      yield {
        kind: "tool-call",
        id: "toolu_wrapup_1",
        name: "list_pages",
        arguments: {},
      };
      yield { kind: "usage", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };
      yield { kind: "done", stopReason: "tool_use" };
    } else {
      yield { kind: "text-delta", text: "submitting result" };
      yield { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
      yield { kind: "done", stopReason: "end_turn" };
    }
  }
}

interface AppendedMessage {
  role: string;
  content: string;
  origin: string | null;
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
      handler: async () => ok({ gate: null }),
    }),
  );
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
  costCapMicrocents: number | undefined,
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
      dispatch: async () => ({ ok: true, content: "[]" }),
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no nested subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-cap-wrapup",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [],
    initialMessages: [{ role: "user", content: "rebuild the pricing cluster" }],
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
    maxOutputTokens: 16384,
    temperature: undefined,
    thinkingBudget: null,
    usage,
    costCapMicrocents,
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

describe("runToolLoop — cost-cap wrap-up nudge (#304)", () => {
  it("injects ONE system-origin wrap-up instruction at >=85% of the child cap", async () => {
    const provider = new TwoTurnToolProvider();
    const fixture = buildFixtureQueryApi();
    // Turn 1 spends ~1.5e9 µ¢; cap 1.6e9 → ~94% ≥ 85% at iteration 2.
    const { result } = await runLoop(provider, fixture, 1_600_000_000);

    expect(provider.calls).toBe(2);
    expect(result.stopReason).toBe("end_turn");

    const nudges = fixture.appended.filter(
      (m) => m.role === "user" && m.content.includes("Cost checkpoint"),
    );
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.origin).toBe("system");
    expect(nudges[0]?.content).toContain("submit_result");
    expect(nudges[0]?.content).toContain("not reached: cost cap");

    // The nudge reached the MODEL on the second provider call, not just
    // the transcript.
    const secondCall = provider.seenMessages[1] ?? [];
    expect(secondCall.some((c) => c.includes("Cost checkpoint"))).toBe(true);
  });

  it("stays silent below the wrap-up line", async () => {
    const provider = new TwoTurnToolProvider();
    const fixture = buildFixtureQueryApi();
    // Spend ~1.5e9 µ¢ vs cap 2e9 → 75% < 85%.
    await runLoop(provider, fixture, 2_000_000_000);
    expect(fixture.appended.filter((m) => m.content.includes("Cost checkpoint"))).toHaveLength(0);
  });

  it("never fires without a child cost cap (ordinary chats)", async () => {
    const provider = new TwoTurnToolProvider();
    const fixture = buildFixtureQueryApi();
    await runLoop(provider, fixture, undefined);
    expect(fixture.appended.filter((m) => m.content.includes("Cost checkpoint"))).toHaveLength(0);
  });
});
