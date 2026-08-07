// SPDX-License-Identifier: MPL-2.0

/**
 * #400 — an approval-ONLY turn: the model calls a single gated tool and
 * NOTHING else (no co-emitted tool-call, no visible text). The mixed
 * pairing suite covers the co-emission shape; this one covers the pure
 * shape, which the international-site `set_locales` flow produces on
 * its very first turn ("add German" → one gated call, nothing to say
 * until the Owner clicks).
 *
 * Regression class: the loop must pause at `awaiting_approval` after
 * ONE provider call — an empty-turn or forced-retry heuristic that
 * ignores `accumulatedApprovalRequests` re-runs the provider in a
 * tight loop until max_loops (200) and the operator never sees the
 * card.
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

class ApprovalOnlyProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-approval-only";
  calls = 0;

  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    yield {
      kind: "tool-approval-request",
      approvalId: "appr-locales-1",
      toolCallId: "tu-locales-1",
      name: "set_locales",
      arguments: { locales: [] },
    };
    yield { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
    yield { kind: "done", stopReason: "tool_use" };
  }
}

function buildFixtureQueryApi(): { registry: OperationRegistry; adapter: DatabaseAdapter } {
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "chat.append_message",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ role: z.string(), content: z.string() }),
      output: z.looseObject({}),
      handler: async () => ok({ messageId: "m1" }),
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
  return { registry, adapter };
}

describe("runToolLoop — approval-only turn", () => {
  it("pauses at awaiting_approval after ONE provider call and surfaces the card", async () => {
    delete process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS;
    const fixture = buildFixtureQueryApi();
    const provider = new ApprovalOnlyProvider();
    const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "r1" };
    const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
    const gen = runToolLoop({
      registry: fixture.registry,
      adapter: fixture.adapter,
      humanCtx: ctx,
      aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
      provider,
      tools: {
        dispatch: async () => ({ ok: true, content: "unexpected dispatch" }),
      } as unknown as ToolRegistry,
      options: {} as ChatRunnerOptions,
      runChatTurn: (() => {
        throw new Error("no subagents in this test");
      }) as unknown as RunChatTurnFn,
      chatSessionId: "cs-approval-only",
      chatBranchId: "cb-1",
      abortSignal: undefined,
      systemChunks: "",
      filteredTools: [],
      initialMessages: [{ role: "user", content: "add German to the site" }],
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
    let result: ToolLoopResult;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        result = step.value;
        break;
      }
      events.push(step.value);
    }

    // ONE provider call — no forced-retry loop chewing to max_loops.
    expect(provider.calls).toBe(1);
    // The card reached the client…
    const approvals = events.filter((e) => e.kind === "tool-approval-request");
    expect(approvals).toHaveLength(1);
    // …and the turn is paused for the Owner's decision.
    expect(result.stopReason).toBe("awaiting_approval");
  });
});
