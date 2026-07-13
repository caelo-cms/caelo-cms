// SPDX-License-Identifier: MPL-2.0

/**
 * Run #8 R1 — regression test for the empty-content-at-output-cap path
 * in `runToolLoop`. Two orchestrator turns in migration run #8 ended
 * with EMPTY content at exactly output_tokens=16384 (`stop_reason:
 * max_tokens` — adaptive thinking consumed the entire budget) and the
 * runner silently persisted an empty assistant message.
 *
 * Contract under test:
 *   1. Empty content + zero tool calls + stopReason=max_tokens →
 *      retry ONCE with a doubled per-call ceiling, never persisting the
 *      empty turn.
 *   2. If the retry is empty too → persist a VISIBLE assistant notice +
 *      yield an error event (no silent empties, CLAUDE.md §2).
 *
 * Same fixture style as loop-compaction-retry.test.ts: provider + Query
 * API are stubs; this exercises the loop's control flow only.
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
 * Fixture provider: the first `emptyCount` calls stream ZERO text and
 * ZERO tool calls and stop at `max_tokens` (the run #8 signature), then
 * a normal text turn. Records each call's maxTokens so tests can assert
 * the retry ceiling was raised.
 */
class EmptyAtCapProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-empty-at-cap";
  readonly seenMaxTokens: (number | undefined)[] = [];

  constructor(private readonly emptyCount: number) {}

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.seenMaxTokens.push(input.maxTokens);
    if (this.seenMaxTokens.length <= this.emptyCount) {
      // Thinking burned the whole budget: usage reports the full cap
      // spent, but no text-delta / tool-call events ever arrived.
      yield { kind: "usage", inputTokens: 1000, outputTokens: 16384, cachedTokens: 0 };
      yield { kind: "done", stopReason: "max_tokens" };
      return;
    }
    yield { kind: "text-delta", text: "recovered with a larger budget" };
    yield { kind: "usage", inputTokens: 1000, outputTokens: 50, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

function buildFixtureQueryApi(): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  appendedMessages: { role: string; content: string }[];
} {
  const appendedMessages: { role: string; content: string }[] = [];
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "chat.append_message",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ role: z.string(), content: z.string() }),
      output: z.looseObject({}),
      handler: async (_ctx, input) => {
        appendedMessages.push({ role: input.role, content: input.content });
        return ok({ messageId: `msg-${appendedMessages.length}` });
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
  return { registry, adapter, appendedMessages };
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
    tools: {} as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-empty-cap",
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

describe("runToolLoop — empty content at the output-token cap (run #8 R1)", () => {
  it("retries once with a doubled ceiling and never persists the empty turn", async () => {
    const provider = new EmptyAtCapProvider(1);
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(provider, fixture);

    // Exactly one retry, at double the original ceiling.
    expect(provider.seenMaxTokens).toEqual([16384, 32768]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);

    // The empty turn was NEVER persisted; only the recovered turn was.
    const assistantMessages = fixture.appendedMessages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0]?.content).toContain("recovered");
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
  });

  it("persists a visible notice + error event when the retry is empty too", async () => {
    const provider = new EmptyAtCapProvider(Number.POSITIVE_INFINITY);
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(provider, fixture);

    // One retry only — no infinite loop.
    expect(provider.seenMaxTokens).toEqual([16384, 32768]);
    expect(result.stopReason).toBe("error");
    expect(result.succeeded).toBe(false);

    // A VISIBLE assistant notice landed in the transcript — never a
    // silent empty message.
    const assistantMessages = fixture.appendedMessages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0]?.content).toContain("output limit");
    expect(assistantMessages[0]?.content?.length).toBeGreaterThan(0);
    expect(result.lastAssistantMessageId).not.toBeNull();

    // And the client saw an error event carrying the same explanation.
    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]?.kind === "error" && errorEvents[0].message).toContain("output limit");
  });
});
