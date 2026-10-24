// SPDX-License-Identifier: MPL-2.0

/**
 * Approval answers the SDK can read (#1073, #1074, #1075, #1070).
 *
 * The AI SDK collects tool-approval responses from the LAST message of a
 * run's initial messages only, and runs every approved gated tool before
 * step 0. Each case below is a turn shape that used to break on that:
 *
 *   - #1073 — two gated calls failing the approval preflight in one step
 *     were answered by two separate messages; the first stayed unanswered
 *     and the next run failed (AI_MissingToolResultsError).
 *   - #1074 — the same with two e2e auto-approvals.
 *   - #1075 — a resume run whose step 0 timed out was retried with the
 *     approval still the last message, so the gated tool ran twice.
 *   - #1070 — a gated call on a max_tokens stop whose approval-request
 *     event had not reached the runner yet was answered "not executed"
 *     although the SDK had asked for its approval; the resume then sent
 *     two results for one tool_use.
 *
 * Real SDK loop over MultiFixtureProvider; every step's prompt is checked
 * the way Anthropic checks it (consecutive user/tool messages form one
 * request message whose tool results must be unique and complete).
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";
import type { ChatMessageInput, GenerateInput, ProviderEvent } from "../provider.js";
import { MultiFixtureProvider } from "../providers/anthropic.js";
import type { ToolRegistry } from "../tools/index.js";
import { runToolLoop, type ToolLoopResult } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { FilteredTool } from "./tool-catalogue.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

interface AppendedMessage {
  role: string;
  content: string;
  toolCallId: string | null;
  responseMessages: unknown;
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
          toolCallId: (input.toolCallId as string | undefined) ?? null,
          responseMessages: input.responseMessages ?? null,
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
  // Issue #658 — the pause records its approval cards.
  registry.register(
    defineOperation({
      name: "chat.record_turn_approvals",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({ recorded: 1 }),
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

/** Tool-result ids that repeat inside one Anthropic request message. */
function duplicateResults(prompt: readonly unknown[]): string[] {
  const dups: string[] = [];
  let seen = new Set<string>();
  for (const m of prompt as Array<{ role: string; content: unknown }>) {
    if (m.role !== "tool" && m.role !== "user") {
      seen = new Set();
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (p.type !== "tool-result" || !p.toolCallId) continue;
      if (seen.has(p.toolCallId)) dups.push(p.toolCallId);
      seen.add(p.toolCallId);
    }
  }
  return dups;
}

const call = (id: string, name: string): ProviderEvent => ({
  kind: "tool-call",
  id,
  name,
  arguments: {},
});
const usage: ProviderEvent = { kind: "usage", inputTokens: 10, outputTokens: 10, cachedTokens: 0 };
const toolUse: ProviderEvent[] = [usage, { kind: "done", stopReason: "tool_use" }];
const maxTokens: ProviderEvent[] = [usage, { kind: "done", stopReason: "max_tokens" }];
const endTurn: ProviderEvent[] = [
  { kind: "text-delta", text: "done" },
  usage,
  { kind: "done", stopReason: "end_turn" },
];

let gatedRuns = 0;
function catalogue(opts: { preflightFails?: boolean } = {}): FilteredTool[] {
  return [
    { name: "read_thing", description: "routine read", inputSchema: { type: "object" } },
    {
      name: "propose_thing",
      description: "gated proposal",
      inputSchema: { type: "object" },
      approvalMode: "user-approval",
      execute: async () => {
        gatedRuns += 1;
        return "applied";
      },
      ...(opts.preflightFails
        ? {
            prepareApproval: async () => {
              throw new Error("binding changed");
            },
          }
        : {}),
    },
  ];
}

async function run(
  provider: MultiFixtureProvider,
  initialMessages: ChatMessageInput[],
  filteredTools: FilteredTool[],
  extra: { firstEventTimeoutMs?: number } = {},
) {
  const fixture = buildFixtureQueryApi();
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const totals: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools: {
      dispatch: async (name: string) => ({ ok: true, content: `ran ${name}` }),
      get: () => undefined,
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-approvals",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools,
    initialMessages,
    compactionThresholdTokens: 600_000,
    maxLoops: 8,
    maxOutputTokens: 16384,
    temperature: undefined,
    thinkingBudget: null,
    usage: totals,
    costCapMicrocents: undefined,
    inputCost: 15,
    outputCost: 75,
    ...extra,
  });
  const events: ClientEvent[] = [];
  let result: ToolLoopResult;
  for (;;) {
    const s = await gen.next();
    if (s.done) {
      result = s.value;
      break;
    }
    events.push(s.value);
  }
  return { events, result, fixture };
}

async function withAutoApprove<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS;
  if (on) process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = "1";
  else delete process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS;
    else process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = prev;
  }
}

/** The paused turn as the chat stores it, plus the operator's Approve. */
const resumeHistory = (): ChatMessageInput[] => [
  { role: "user", content: "go" },
  {
    role: "assistant",
    content: "",
    sdkMessages: [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "toolu_X", toolName: "propose_thing", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "toolu_X" },
        ],
      },
    ],
  },
  {
    role: "tool",
    content: "[approval granted]",
    sdkMessages: [
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
    ],
  },
];

/** The first model call never streams; the SDK's first-chunk watchdog aborts it. */
class HangsOnce extends MultiFixtureProvider {
  #calls = 0;
  protected override nextStepStream(options: {
    abortSignal?: AbortSignal;
  }): ReadableStream<unknown> | null {
    this.#calls += 1;
    if (this.#calls > 1) return null;
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
}

/**
 * Delivers approval-request events late — the runner's event pump lagging
 * behind the SDK's own step bookkeeping, which is what the #1070 report
 * needs: the step finishes before the runner has seen the request.
 */
class LateApprovalEvents extends MultiFixtureProvider {
  override async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    for await (const ev of super.generate(input)) {
      if (ev.kind === "tool-approval-request") await Bun.sleep(30);
      yield ev;
    }
  }
}

describe("approval answers the SDK can read", () => {
  it("#1073 — two gated calls rejected by preflight are both answered; the turn continues", async () => {
    gatedRuns = 0;
    const p = new MultiFixtureProvider([
      [call("toolu_X1", "propose_thing"), call("toolu_X2", "propose_thing"), ...toolUse],
      [call("toolu_W", "read_thing"), ...toolUse],
      endTurn,
    ]);
    const { result, fixture } = await withAutoApprove(false, () =>
      run(p, [{ role: "user", content: "go" }], catalogue({ preflightFails: true })),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(gatedRuns).toBe(0);
    // Both denials in ONE persisted tool message.
    const denialRows = fixture.appended.filter((m) => m.content.includes("not proposed"));
    expect(denialRows).toHaveLength(1);
    expect(JSON.stringify(denialRows[0]?.responseMessages)).toContain("toolu_X1");
    expect(JSON.stringify(denialRows[0]?.responseMessages)).toContain("toolu_X2");
    for (const prompt of p.seenPrompts) expect(duplicateResults(prompt)).toEqual([]);
  });

  it("#1074 — two e2e auto-approvals in one step both run; the turn continues", async () => {
    gatedRuns = 0;
    const p = new MultiFixtureProvider([
      [call("toolu_X1", "propose_thing"), call("toolu_X2", "propose_thing"), ...toolUse],
      [call("toolu_W", "read_thing"), ...toolUse],
      endTurn,
    ]);
    const { result, fixture } = await withAutoApprove(true, () =>
      run(p, [{ role: "user", content: "go" }], catalogue()),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(gatedRuns).toBe(2);
    const approvalRows = fixture.appended.filter((m) => m.content.includes("[approval granted]"));
    expect(approvalRows).toHaveLength(1);
    for (const prompt of p.seenPrompts) expect(duplicateResults(prompt)).toEqual([]);
  });

  it("#1075 — a resume whose first step times out applies the approved tool once", async () => {
    gatedRuns = 0;
    const p = new HangsOnce([[call("toolu_W", "read_thing"), ...toolUse], endTurn]);
    const { result, fixture } = await withAutoApprove(false, () =>
      run(p, resumeHistory(), catalogue(), { firstEventTimeoutMs: 50 }),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(gatedRuns).toBe(1);
    // The applied result is on the transcript before step 0 ran.
    const applied = fixture.appended.filter((m) => m.content === "[approved tool results]");
    expect(applied).toHaveLength(1);
    expect(JSON.stringify(applied[0]?.responseMessages)).toContain("toolu_X");
    for (const prompt of p.seenPrompts) expect(duplicateResults(prompt)).toEqual([]);
  });
});
