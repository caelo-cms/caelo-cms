// SPDX-License-Identifier: MPL-2.0

/**
 * issue #300 part B — loop-level tests for proactive tool-result
 * compaction inside `runToolLoop`:
 *
 *   1. results a turn dispatched >= 3 loops earlier ride to the
 *      provider as one-line summaries, while recent + failed results
 *      stay verbatim;
 *   2. the persisted transcript keeps FULL result bodies (compaction
 *      is provider-history-only);
 *   3. the pass COMPOSES with issue #261's ceiling-triggered
 *      compaction: pre-turn history stays #261's job, and a low
 *      ceiling still triggers the #261 pass on top without either
 *      pass re-cutting the other's output.
 *
 * Same stub style as loop-compaction-retry.test.ts: provider + Query
 * API are fixtures (no DB); this exercises loop control-flow only.
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

const PAGE_UUID = "0f8b4a1c-2d3e-4f50-9a6b-7c8d9e0f1a2b";

/** ~5KB successful build result with the page id buried in the body. */
function bigOkContent(n: number): string {
  return `ok: built page /page-${n}\n${"<section>module html</section>".repeat(160)}{"pageId":"${PAGE_UUID}"}`;
}

/** ~5KB failed result — must survive verbatim for the model to read. */
function bigErrContent(n: number): string {
  return `err: build_page /page-${n} failed: template mismatch\n${"stack frame\n".repeat(400)}`;
}

/**
 * Emits one `build_page` tool call per provider call for `toolLoops`
 * loops, then a closing text turn. Records the messages of every call
 * so tests can assert what the provider actually saw per loop.
 */
class ToolLoopingProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-tool-looping";
  readonly seenMessages: (readonly ChatMessageInput[])[] = [];
  private calls = 0;

  constructor(private readonly toolLoops: number) {}

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.seenMessages.push(input.messages);
    const n = this.calls++;
    if (n < this.toolLoops) {
      yield {
        kind: "tool-call",
        id: `t-${n}`,
        name: "build_page",
        arguments: { n },
      };
      yield { kind: "usage", inputTokens: 100, outputTokens: 50, cachedTokens: 0 };
      yield { kind: "done", stopReason: "tool_use" };
      return;
    }
    yield { kind: "text-delta", text: "all pages built" };
    yield { kind: "usage", inputTokens: 100, outputTokens: 10, cachedTokens: 0 };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

function buildFixtureQueryApi(): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  appended: { role: string; content: string; toolCallId: string | null }[];
} {
  const appended: { role: string; content: string; toolCallId: string | null }[] = [];
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
          toolCallId: (input.toolCallId as string | undefined) ?? null,
        });
        return ok({ messageId: `msg-${appended.length}` });
      },
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

async function runLoop(args: {
  provider: AIProvider;
  fixture: ReturnType<typeof buildFixtureQueryApi>;
  /** 0-based dispatch indices whose result should FAIL. */
  failingDispatches?: ReadonlySet<number>;
  initialMessages?: ChatMessageInput[];
  compactionThresholdTokens?: number;
}): Promise<{ events: ClientEvent[]; result: ToolLoopResult }> {
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  let dispatchCount = 0;
  const gen = runToolLoop({
    registry: args.fixture.registry,
    adapter: args.fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider: args.provider,
    tools: {
      dispatch: async (_name: string, toolArgs: { n: number }) => {
        const i = dispatchCount++;
        return args.failingDispatches?.has(i)
          ? { ok: false, content: bigErrContent(toolArgs.n) }
          : { ok: true, content: bigOkContent(toolArgs.n) };
      },
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-proactive",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [],
    initialMessages: args.initialMessages ?? [{ role: "user", content: "migrate all pages" }],
    compactionThresholdTokens: args.compactionThresholdTokens ?? 600_000,
    maxLoops: 10,
    maxOutputTokens: 4096,
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

/** The tool-result message for a given toolCallId in one provider call's history. */
function toolResult(
  history: readonly ChatMessageInput[] | undefined,
  toolCallId: string,
): ChatMessageInput | undefined {
  return history?.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
}

describe("runToolLoop — proactive tool-result compaction (issue #300)", () => {
  it("summarizes old successful results, keeps recent + failed verbatim, persists full bodies", async () => {
    const provider = new ToolLoopingProvider(6);
    const fixture = buildFixtureQueryApi();
    // Dispatch index 1 (loop 1's build) fails.
    const { events, result } = await runLoop({
      provider,
      fixture,
      failingDispatches: new Set([1]),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    // 6 tool loops + 1 closing text turn.
    expect(provider.seenMessages.length).toBe(7);

    // Loop 3's call: t-0 (age 3) is NOT yet compacted going INTO loop 3?
    // No — the pass runs at the TOP of loop 3, so the loop-3 call is the
    // first to see t-0 summarized. Ages at loop 3: t-0=3 (cut), t-1=2,
    // t-2=1 (both verbatim).
    const atLoop3 = provider.seenMessages[3];
    expect(toolResult(atLoop3, "t-0")?.content).toMatch(/\[truncated: \d+ chars\]/);
    expect(toolResult(atLoop3, "t-2")?.content).toBe(bigOkContent(2));

    // The summary keeps the ok line + the page id buried in the body.
    const summarized = toolResult(provider.seenMessages[6], "t-0")?.content ?? "";
    expect(summarized.startsWith("ok: built page /page-0")).toBe(true);
    expect(summarized).toContain(PAGE_UUID);
    expect(summarized.length).toBeLessThan(600);

    // Loop 2's call: nothing is old enough yet — everything verbatim.
    const atLoop2 = provider.seenMessages[2];
    expect(toolResult(atLoop2, "t-0")?.content).toBe(bigOkContent(0));

    // The FAILED loop-1 result stays verbatim through the LAST call,
    // long past the age threshold.
    const lastCall = provider.seenMessages[6];
    expect(toolResult(lastCall, "t-1")?.content).toBe(bigErrContent(1));
    // While old successful ones (t-0..t-3 minus the failure) are summaries.
    expect(toolResult(lastCall, "t-2")?.content).toMatch(/\[truncated: \d+ chars\]/);
    expect(toolResult(lastCall, "t-3")?.content).toMatch(/\[truncated: \d+ chars\]/);
    // And the two most recent stay verbatim.
    expect(toolResult(lastCall, "t-4")?.content).toBe(bigOkContent(4));
    expect(toolResult(lastCall, "t-5")?.content).toBe(bigOkContent(5));

    // Persistence: every tool row in the transcript carries the FULL
    // body — the proactive pass never rewrites stored records.
    const persistedToolRows = fixture.appended.filter((m) => m.role === "tool");
    expect(persistedToolRows.length).toBe(6);
    for (const row of persistedToolRows) {
      expect(row.content).not.toContain("[truncated:");
      expect(row.content.length).toBeGreaterThan(4000);
    }
  });

  it("leaves pre-turn tool results to #261 — the proactive pass never touches them", async () => {
    const provider = new ToolLoopingProvider(5);
    const fixture = buildFixtureQueryApi();
    const preTurnDump = "H".repeat(40_000);
    const { result } = await runLoop({
      provider,
      fixture,
      initialMessages: [
        { role: "user", content: "rebuild" },
        {
          role: "assistant",
          content: "reading",
          toolCalls: [{ id: "t-prior", name: "get_page", arguments: {} }],
        },
        { role: "tool", content: preTurnDump, toolCallId: "t-prior" },
        { role: "user", content: "continue the migration" },
      ],
    });

    expect(result.succeeded).toBe(true);
    // Ceiling never hit (600K threshold) → the prior-turn 40KB dump
    // rides verbatim into every call; only current-turn results shrink.
    const lastCall = provider.seenMessages[provider.seenMessages.length - 1];
    expect(toolResult(lastCall, "t-prior")?.content).toBe(preTurnDump);
    expect(toolResult(lastCall, "t-0")?.content).toMatch(/\[truncated: \d+ chars\]/);
  });

  it("composes with the #261 ceiling pass: both fire, neither re-cuts the other's output", async () => {
    const provider = new ToolLoopingProvider(5);
    const fixture = buildFixtureQueryApi();
    const preTurnDump = "H".repeat(40_000);
    const { events, result } = await runLoop({
      provider,
      fixture,
      // ~10K-token ceiling: the 40KB pre-turn dump alone crosses it, so
      // the #261 pre-flight fires while the proactive pass handles the
      // current turn's results.
      compactionThresholdTokens: 10_000,
      initialMessages: [
        { role: "user", content: "rebuild" },
        {
          role: "assistant",
          content: "reading",
          toolCalls: [{ id: "t-prior", name: "get_page", arguments: {} }],
        },
        { role: "tool", content: preTurnDump, toolCallId: "t-prior" },
        { role: "user", content: "continue the migration" },
      ],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);

    const lastCall = provider.seenMessages[provider.seenMessages.length - 1];
    // #261 truncated the pre-turn dump (500-char head + marker).
    const prior = toolResult(lastCall, "t-prior")?.content ?? "";
    expect(prior).toContain("[truncated:");
    expect(prior.length).toBeLessThan(1000);
    // The proactive pass summarized the old current-turn result, and the
    // marker appears exactly once — the #261 pass did not re-cut it.
    const t0 = toolResult(lastCall, "t-0")?.content ?? "";
    expect(t0.startsWith("ok: built page /page-0")).toBe(true);
    expect(t0.match(/\[truncated:/g)?.length).toBe(1);
  });
});
