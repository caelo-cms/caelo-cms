// SPDX-License-Identifier: MPL-2.0

/**
 * issue #261 — regression test for the prompt-too-long recovery path in
 * `runToolLoop`: a provider that rejects the first call with the exact
 * run #7 context-overflow error must trigger ONE harder compaction +
 * retry (not surface the raw error), and a provider that keeps
 * rejecting must persist a clear operator-facing assistant notice.
 *
 * Provider + Query API are fixtures (no DB): the adapter runs the stub
 * `chat.append_message` handler directly. Real-Postgres behaviour of
 * the op itself is covered by the chat integration suites.
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
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/** The exact provider message that killed run #7 (issue #261). */
const RUN_7_ERROR = "prompt is too long: 1202876 tokens > 1000000 maximum";

/**
 * Fixture provider: rejects the first `failCount` calls with the run #7
 * context-overflow error, then streams a normal text-only turn. Records
 * the messages of every call so tests can assert the retry went out
 * with a compacted history.
 */
class OverflowingProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-overflow";
  readonly seenMessages: (readonly ChatMessageInput[])[] = [];

  constructor(private readonly failCount: number) {}

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.seenMessages.push(input.messages);
    if (this.seenMessages.length <= this.failCount) {
      yield { kind: "error", message: RUN_7_ERROR };
      yield { kind: "done", stopReason: "error" };
      return;
    }
    yield { kind: "text-delta", text: "recovered after compaction" };
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
  // The fixture adapter runs the handler directly (no Postgres, no tx) —
  // this test exercises the loop's control flow, not the op.
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter, appendedMessages };
}

/** History with one operator turn and an old 40KB tool dump to compact away. */
function initialMessages(): ChatMessageInput[] {
  return [
    { role: "user", content: "rebuild the pricing page" },
    {
      role: "assistant",
      content: "reading the page",
      toolCalls: [{ id: "t1", name: "pages.get", arguments: {} }],
    },
    { role: "tool", content: "H".repeat(40_000), toolCallId: "t1" },
    ...Array.from({ length: 10 }, (_, i): ChatMessageInput => {
      return i % 2 === 0
        ? { role: "user", content: `follow-up ${i}` }
        : { role: "assistant", content: `answer ${i}` };
    }),
    { role: "user", content: "continue" },
  ];
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
    initialMessages: initialMessages(),
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
    maxOutputTokens: 1024,
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

describe("runToolLoop — prompt-too-long compact + retry (issue #261)", () => {
  it("compacts harder and retries once, without surfacing the raw provider error", async () => {
    const provider = new OverflowingProvider(1);
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(provider, fixture);

    // Retried exactly once and recovered.
    expect(provider.seenMessages.length).toBe(2);
    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);

    // The retry call went out with a compacted history: the 40KB tool
    // dump was truncated to head + marker.
    const retryToolResult = provider.seenMessages[1]?.find((m) => m.role === "tool");
    expect(retryToolResult?.content).toContain("[truncated:");
    expect(retryToolResult?.content.length).toBeLessThan(1_000);
    // The latest user message survived compaction verbatim.
    expect(provider.seenMessages[1]?.some((m) => m.content === "continue")).toBe(true);

    // The raw context-overflow error never reached the client.
    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents).toEqual([]);
    // The recovered turn streamed + persisted normally.
    expect(events.some((e) => e.kind === "text-delta" && e.text.includes("recovered"))).toBe(true);
    expect(fixture.appendedMessages.some((m) => m.content.includes("recovered"))).toBe(true);
  });

  it("persists a clear operator notice when the retry still overflows", async () => {
    const provider = new OverflowingProvider(Number.POSITIVE_INFINITY);
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(provider, fixture);

    // Retry is spent after ONE extra attempt — no infinite loop.
    expect(provider.seenMessages.length).toBe(2);
    expect(result.stopReason).toBe("error");
    expect(result.succeeded).toBe(false);

    // A clear assistant notice landed in the transcript: what happened
    // (compacted) + what to do (retry / new chat).
    const notice = fixture.appendedMessages.find((m) => m.role === "assistant");
    expect(notice?.content).toContain("compacted");
    expect(notice?.content).toContain("send your message again");
    expect(result.lastAssistantMessageId).not.toBeNull();

    // The client saw the notice as an error event — never the raw
    // provider message.
    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]?.kind === "error" && errorEvents[0].message).toContain("compacted");
    expect(events.some((e) => e.kind === "error" && e.message.includes("prompt is too long"))).toBe(
      false,
    );
  });
});
