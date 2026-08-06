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

import type { AIProvider, ChatMessageInput, ProviderEvent } from "../provider.js";
import { FixtureProvider } from "../providers/anthropic.js";
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
 * Emits one `build_page` tool call per model STEP for `toolLoops` steps,
 * then a closing text step. issue #442 — the per-step request histories are
 * observed at the mock-model boundary (`seenPrompts`), since the SDK loop
 * builds each step's messages from the chat-runner's prepareStep override.
 */
class ToolLoopingProvider extends FixtureProvider {
  private calls = 0;

  constructor(private readonly toolLoops: number) {
    super([], "fixture-tool-looping");
  }

  protected override nextStepEvents(): readonly ProviderEvent[] {
    const n = this.calls++;
    if (n < this.toolLoops) {
      return [
        { kind: "tool-call", id: `t-${n}`, name: "build_page", arguments: { n } },
        { kind: "usage", inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "all pages built" },
      { kind: "usage", inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
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
  compactionTargetTokens?: number;
  compactionRecentTokens?: number;
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
    filteredTools: [
      { name: "build_page", description: "fixture build_page", inputSchema: { type: "object" } },
    ],
    initialMessages: args.initialMessages ?? [{ role: "user", content: "migrate all pages" }],
    compactionThresholdTokens: args.compactionThresholdTokens ?? 600_000,
    ...(args.compactionTargetTokens !== undefined
      ? { compactionTargetTokens: args.compactionTargetTokens }
      : {}),
    ...(args.compactionRecentTokens !== undefined
      ? { compactionRecentTokens: args.compactionRecentTokens }
      : {}),
    // This suite exercises the proactive pass itself, so opt it in
    // explicitly — it is OFF by default in production now (cache thrash).
    proactiveCompaction: true,
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

/**
 * The tool-result CONTENT for a given toolCallId in one STEP's model-level
 * prompt (FixtureProvider.seenPrompts). Tool rows convert to role:"tool"
 * messages whose tool-result parts carry the text in `output.value`.
 */
function toolResultText(prompt: readonly unknown[] | undefined, toolCallId: string): string | null {
  for (const msg of prompt ?? []) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const pt = part as {
        type?: string;
        toolCallId?: string;
        output?: { value?: unknown };
        result?: unknown;
      };
      if (pt.type === "tool-result" && pt.toolCallId === toolCallId) {
        const v = pt.output?.value ?? pt.result;
        return typeof v === "string" ? v : JSON.stringify(v);
      }
    }
  }
  return null;
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
    // 6 tool steps + 1 closing text step.
    expect(provider.seenPrompts.length).toBe(7);

    // Step 3's call: the pass runs in prepareStep(3), so the step-3 call is
    // the first to see t-0 summarized. Ages at step 3: t-0=3 (cut), t-1=2,
    // t-2=1 (both verbatim).
    const atLoop3 = provider.seenPrompts[3];
    expect(toolResultText(atLoop3, "t-0")).toMatch(/\[truncated: \d+ chars\]/);
    expect(toolResultText(atLoop3, "t-2")).toBe(bigOkContent(2));

    // The summary keeps the ok line + the page id buried in the body.
    const summarized = toolResultText(provider.seenPrompts[6], "t-0") ?? "";
    expect(summarized.startsWith("ok: built page /page-0")).toBe(true);
    expect(summarized).toContain(PAGE_UUID);
    expect(summarized.length).toBeLessThan(600);

    // Step 2's call: nothing is old enough yet — everything verbatim.
    const atLoop2 = provider.seenPrompts[2];
    expect(toolResultText(atLoop2, "t-0")).toBe(bigOkContent(0));

    // The FAILED step-1 result stays verbatim through the LAST call,
    // long past the age threshold.
    const lastCall = provider.seenPrompts[6];
    expect(toolResultText(lastCall, "t-1")).toBe(bigErrContent(1));
    // While old successful ones (t-0..t-3 minus the failure) are summaries.
    expect(toolResultText(lastCall, "t-2")).toMatch(/\[truncated: \d+ chars\]/);
    expect(toolResultText(lastCall, "t-3")).toMatch(/\[truncated: \d+ chars\]/);
    // And the two most recent stay verbatim.
    expect(toolResultText(lastCall, "t-4")).toBe(bigOkContent(4));
    expect(toolResultText(lastCall, "t-5")).toBe(bigOkContent(5));

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
    const lastCall = provider.seenPrompts[provider.seenPrompts.length - 1];
    expect(toolResultText(lastCall, "t-prior")).toBe(preTurnDump);
    expect(toolResultText(lastCall, "t-0")).toMatch(/\[truncated: \d+ chars\]/);
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
      // current turn's results. Target + recent scaled to these tiny
      // fixtures: a 3K recent budget can't fit the 10K dump, so it stays
      // outside the protected tail and Stage-1 truncates it.
      compactionThresholdTokens: 10_000,
      compactionTargetTokens: 3_000,
      compactionRecentTokens: 3_000,
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

    const lastCall = provider.seenPrompts[provider.seenPrompts.length - 1];
    // #261 truncated the pre-turn dump (500-char head + marker).
    const prior = toolResultText(lastCall, "t-prior") ?? "";
    expect(prior).toContain("[truncated:");
    expect(prior.length).toBeLessThan(1000);
    // The proactive pass summarized the old current-turn result, and the
    // marker appears exactly once — the #261 pass did not re-cut it.
    const t0 = toolResultText(lastCall, "t-0") ?? "";
    expect(t0.startsWith("ok: built page /page-0")).toBe(true);
    expect(t0.match(/\[truncated:/g)?.length).toBe(1);
  });
});
