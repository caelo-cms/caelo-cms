// SPDX-License-Identifier: MPL-2.0

/**
 * Run #10 D5 — first-token silence watchdog tests (issue #442: the watchdog
 * is the AI SDK's native per-step `timeout.firstChunkMs` now).
 *
 * Run #10's live shape: the operator's first message on a fresh chat
 * produced NO stream events and NO persisted assistant turn for 12
 * minutes; SSE keep-alives + heartbeats kept every proxy and the client
 * watchdog quiet, so a hung provider request was indistinguishable from
 * a healthy long turn. These tests lock in the recovery: a model call
 * that yields ZERO chunks inside the watchdog window is aborted by the
 * SDK + retried once by the outer loop; a second all-silent call becomes
 * a VISIBLE persisted notice, never an indefinite hang.
 *
 * Provider + Query API are fixtures (no DB); the hang is scripted at the
 * MOCK MODEL level (a stream that never enqueues) so the REAL SDK
 * timeout machinery fires.
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
import { runToolLoop, type ToolLoopResult } from "./loop.js";
import { RepeatedFailureTracker } from "./repeat-failure-guard.js";
import { streamProviderTurn, type UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/**
 * Fixture provider: the first `hangCount` model calls never emit a chunk
 * (the stream errors with the SDK watchdog's abort reason when it fires);
 * later calls stream a normal text-only step.
 */
class HangingProvider extends FixtureProvider {
  calls = 0;

  constructor(private readonly hangCount: number) {
    super([], "fixture-hang");
  }

  protected override nextStepStream(options: {
    abortSignal?: AbortSignal;
  }): ReadableStream<unknown> | null {
    this.calls += 1;
    if (this.calls > this.hangCount) return null;
    // Hang until the SDK's first-chunk watchdog aborts — mirrors an HTTP
    // request that connected but never streams a byte. Erroring with the
    // abort REASON propagates the SDK's TimeoutError message, exactly like
    // an aborted fetch does.
    return new ReadableStream<unknown>({
      start(controller) {
        const sig = options.abortSignal;
        const fail = (): void => {
          try {
            controller.error(sig?.reason ?? new Error("aborted"));
          } catch {
            /* already errored */
          }
        };
        if (sig?.aborted) fail();
        else sig?.addEventListener("abort", fail, { once: true });
      },
    });
  }

  protected override nextStepEvents(): readonly ProviderEvent[] {
    return [
      { kind: "text-delta", text: "responding after the hang" },
      { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
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

/** Drives ONE SDK run directly (the streamProviderTurn surface). */
async function runStream(
  provider: AIProvider,
  fixture: ReturnType<typeof buildFixtureQueryApi>,
): Promise<{
  events: ClientEvent[];
  result: Awaited<ReturnType<AsyncGenerator<ClientEvent, never>["return"]>> extends never
    ? never
    : import("./streaming.js").StreamTurnResult;
}> {
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = streamProviderTurn({
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
    systemPrompt: "",
    history: { messages: [{ role: "user", content: "hi" }] },
    filteredTools: [],
    policy: {
      prepareStep: async () => undefined,
      stopWhen: () => false,
    },
    forceToolChoiceFirstStep: false,
    stepCounter: { value: 0 },
    maxTokens: 1024,
    temperature: undefined,
    thinkingBudget: null,
    usage,
    firstEventTimeoutMs: 50,
    failureTracker: new RepeatedFailureTracker(),
    toolResultOrigins: new Map(),
    turnToolNames: [],
    turnState: { hasWritten: false },
  });
  const events: ClientEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      return { events, result: step.value } as never;
    }
    events.push(step.value);
  }
}

describe("streamProviderTurn — first-event watchdog (run #10 D5)", () => {
  it("aborts an all-silent model call and reports firstEventTimedOut", async () => {
    const provider = new HangingProvider(Number.POSITIVE_INFINITY);
    const { events, result } = await runStream(provider, buildFixtureQueryApi());
    expect(result.firstEventTimedOut).toBe(true);
    expect(result.providerErr).toBe(true);
    // Nothing is yielded to the client here — loop.ts owns messaging.
    expect(events).toEqual([]);
  });

  it("does not trip once the stream is alive, even if later gaps exceed the window", async () => {
    class SlowMiddleProvider extends FixtureProvider {
      constructor() {
        super([], "fixture-slow-middle");
      }
      protected override nextStepStream(): ReadableStream<unknown> | null {
        return new ReadableStream<unknown>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "fast first token" });
            // In-stream gap longer than the 50ms watchdog window.
            await new Promise((resolve) => setTimeout(resolve, 120));
            controller.enqueue({ type: "text-delta", id: "t", delta: " …slow tail" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            });
            controller.close();
          },
        });
      }
    }
    const { events, result } = await runStream(new SlowMiddleProvider(), buildFixtureQueryApi());
    expect(result.firstEventTimedOut).toBe(false);
    expect(result.providerErr).toBe(false);
    const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
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
