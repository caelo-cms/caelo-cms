// SPDX-License-Identifier: MPL-2.0

/**
 * Run #10 D5 — first-token silence watchdog tests.
 *
 * Run #10's live shape: the operator's first message on a fresh chat
 * produced NO stream events and NO persisted assistant turn for 12
 * minutes; SSE keep-alives + heartbeats kept every proxy and the client
 * watchdog quiet, so a hung provider request was indistinguishable from
 * a healthy long turn. These tests lock in the recovery: a provider
 * call that yields ZERO events inside the watchdog window is aborted +
 * retried once; a second all-silent call becomes a VISIBLE persisted
 * notice, never an indefinite hang.
 *
 * Provider + Query API are fixtures (no DB) — same harness as
 * loop-compaction-retry.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { AIProvider, ChatMessageInput, GenerateInput, ProviderEvent } from "../provider.js";
import type { ToolRegistry } from "../tools/index.js";
import { runToolLoop, type ToolLoopResult } from "./loop.js";
import { streamProviderTurn, type UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/**
 * Fixture provider: the first `hangCount` calls never emit an event
 * (they wait on the abort signal the watchdog fires); later calls
 * stream a normal text-only turn.
 */
class HangingProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-hang";
  calls = 0;

  constructor(private readonly hangCount: number) {}

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls <= this.hangCount) {
      // Hang until aborted — mirrors an HTTP request that connected
      // but never streams a byte.
      await new Promise<void>((resolve) => {
        if (input.abortSignal?.aborted) resolve();
        else input.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    yield { kind: "text-delta", text: "responding after the hang" };
    yield { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
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
    chatSessionId: "cs-1",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [],
    initialMessages: [{ role: "user", content: "hello" }],
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
    maxOutputTokens: 1024,
    temperature: undefined,
    thinkingBudget: null,
    usage,
    costCapMicrocents: undefined,
    inputCost: 15,
    outputCost: 75,
    firstEventTimeoutMs: 50,
  });
  const events: ClientEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe("streamProviderTurn — first-event watchdog (run #10 D5)", () => {
  it("aborts an all-silent provider call and reports firstEventTimedOut", async () => {
    const provider = new HangingProvider(Number.POSITIVE_INFINITY);
    const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
    const gen = streamProviderTurn({
      provider,
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }] as ChatMessageInput[],
      tools: [],
      abortSignal: undefined,
      maxTokens: 1024,
      temperature: undefined,
      thinkingBudget: null,
      usage,
      costCapMicrocents: undefined,
      inputCost: 15,
      outputCost: 75,
      firstEventTimeoutMs: 50,
    });
    const events: ClientEvent[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value.firstEventTimedOut).toBe(true);
        expect(step.value.providerErr).toBe(true);
        break;
      }
      events.push(step.value);
    }
    // Nothing is yielded to the client here — loop.ts owns messaging.
    expect(events).toEqual([]);
  });

  it("does not trip once the stream is alive, even if later gaps exceed the window", async () => {
    class SlowMiddleProvider implements AIProvider {
      readonly name = "anthropic" as const;
      readonly model = "fixture-slow-middle";
      async *generate(): AsyncIterable<ProviderEvent> {
        yield { kind: "text-delta", text: "fast first token" };
        // In-stream gap longer than the 50ms watchdog window.
        await new Promise((resolve) => setTimeout(resolve, 120));
        yield { kind: "text-delta", text: " …slow tail" };
        yield { kind: "done", stopReason: "end_turn" };
      }
    }
    const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
    const gen = streamProviderTurn({
      provider: new SlowMiddleProvider(),
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }] as ChatMessageInput[],
      tools: [],
      abortSignal: undefined,
      maxTokens: 1024,
      temperature: undefined,
      thinkingBudget: null,
      usage,
      costCapMicrocents: undefined,
      inputCost: 15,
      outputCost: 75,
      firstEventTimeoutMs: 50,
    });
    const texts: string[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value.firstEventTimedOut).toBe(false);
        expect(step.value.providerErr).toBe(false);
        break;
      }
      if (step.value.kind === "text-delta") texts.push(step.value.text);
    }
    expect(texts.join("")).toBe("fast first token …slow tail");
  });
});

describe("runToolLoop — first-event-timeout retry (run #10 D5)", () => {
  it("retries once after a silent call and recovers", async () => {
    const provider = new HangingProvider(1);
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(provider, fixture);

    expect(provider.calls).toBe(2);
    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(fixture.appendedMessages.some((m) => m.content.includes("after the hang"))).toBe(true);
  });

  it("persists a visible notice when the retry is silent too", async () => {
    const provider = new HangingProvider(Number.POSITIVE_INFINITY);
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(provider, fixture);

    // Retry spent after ONE extra attempt — no infinite silence.
    expect(provider.calls).toBe(2);
    expect(result.stopReason).toBe("error");
    expect(result.succeeded).toBe(false);

    const notice = fixture.appendedMessages.find((m) => m.role === "assistant");
    expect(notice?.content).toContain("did not start responding");
    expect(notice?.content).toContain("send your message again");
    expect(result.lastAssistantMessageId).not.toBeNull();

    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents.length).toBe(1);
  });
});
