// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: the tool-loop must persist a tool_result for EVERY tool call
 * the model emits, whatever the stop_reason — the "no tool_use without a
 * matching tool_result" pairing invariant.
 *
 * The live wedge (migration run, homepage design checkpoint): the model
 * emitted `offer_choices` (twice) and the stream stopped with
 * `stop_reason: max_tokens` — adaptive thinking consumed the output budget
 * right after the tool_use blocks. Pre-fix, `runToolLoop` only dispatched
 * tool calls when `loopStop === "tool_use"`, so a `max_tokens` stop
 * persisted the assistant tool_use but ZERO tool_results. That dangling
 * pair 400'd every subsequent turn ("Tool results are missing for tool
 * calls toolu_014…, toolu_01W…") and permanently bricked the chat, even
 * after a full page reload and even when the operator answered by typing
 * free text instead of clicking the choice card.
 *
 * Same stub style as loop-empty-at-cap.test.ts: provider + Query API are
 * fixtures; this exercises the loop's dispatch control-flow only.
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
 * Emits two `offer_choices` tool-calls, then a usage event at the output
 * cap, then `done: max_tokens` — the live wedge shape. `offer_choices` is a
 * turn-ending ask whose handler returns synchronously, so both calls are
 * fully-formed by the time the cap is hit.
 */
class OfferChoicesAtCapProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-offer-choices-at-cap";

  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    yield {
      kind: "tool-call",
      id: "toolu_014TWADPKDFAs31Ya6XnRHoW",
      name: "offer_choices",
      arguments: { question: "Bold or minimal hero?", options: [] },
    };
    yield {
      kind: "tool-call",
      id: "toolu_01WJ2BZfArG452qnnz17MhE1",
      name: "offer_choices",
      arguments: { question: "Bold or minimal hero?", options: [] },
    };
    yield { kind: "usage", inputTokens: 2000, outputTokens: 16384, cachedTokens: 0 };
    yield { kind: "done", stopReason: "max_tokens" };
  }
}

interface AppendedMessage {
  role: string;
  content: string;
  toolCalls: unknown;
  toolCallId: string | null;
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
          toolCalls: input.toolCalls ?? null,
          toolCallId: (input.toolCallId as string | undefined) ?? null,
        });
        return ok({ messageId: `msg-${appended.length}` });
      },
    }),
  );
  // Dedup cache: always a miss so every dispatch runs + persists.
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
): Promise<{ events: ClientEvent[]; result: ToolLoopResult }> {
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    // offer_choices' handler is synchronous + side-effect-free; the stub
    // returns the canonical ChoiceCard content the real handler produces.
    tools: {
      dispatch: async () => ({
        ok: true,
        content: "Choices offered: Bold or minimal hero?\nA) Bold\nB) Minimal",
      }),
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-offer-choices-cap",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [],
    initialMessages: [{ role: "user", content: "design the homepage hero" }],
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

describe("runToolLoop — tool_use/tool_result pairing at a non-tool_use stop", () => {
  it("dispatches every accumulated tool call at a max_tokens stop (no dangling tool_use)", async () => {
    const fixture = buildFixtureQueryApi();
    const { events, result } = await runLoop(new OfferChoicesAtCapProvider(), fixture);

    const assistant = fixture.appended.filter((m) => m.role === "assistant");
    const toolResults = fixture.appended.filter((m) => m.role === "tool");

    // The assistant turn with both offer_choices tool_use blocks persisted.
    expect(assistant).toHaveLength(1);
    const persistedToolCallIds = (assistant[0]?.toolCalls as { id: string }[] | null)?.map(
      (c) => c.id,
    );
    expect(persistedToolCallIds).toEqual([
      "toolu_014TWADPKDFAs31Ya6XnRHoW",
      "toolu_01WJ2BZfArG452qnnz17MhE1",
    ]);

    // CRITICAL: a tool_result is persisted for EACH tool_use — the pairing
    // invariant holds in the transcript, so no dangling pair can 400 a
    // later turn. Pre-fix this was zero.
    expect(toolResults.map((m) => m.toolCallId)).toEqual([
      "toolu_014TWADPKDFAs31Ya6XnRHoW",
      "toolu_01WJ2BZfArG452qnnz17MhE1",
    ]);

    // Every persisted tool_use id has a matching persisted tool_result id.
    const useIds = new Set(persistedToolCallIds);
    const resultIds = new Set(toolResults.map((m) => m.toolCallId));
    for (const id of useIds) expect(resultIds.has(id)).toBe(true);

    // The turn ends on the max_tokens stop (it does not loop forever) and
    // the client saw the choice-card content on the tool-result events.
    expect(result.stopReason).toBe("max_tokens");
    const toolResultEvents = events.filter((e) => e.kind === "tool-result");
    expect(toolResultEvents).toHaveLength(2);
  });
});
