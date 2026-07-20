// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: a turn that co-emits a NON-gated tool call alongside an
 * SDK-needsApproval (gated) tool must still pair the non-gated call with a
 * tool_result. The pairing invariant is "no tool_use without a matching
 * tool_result".
 *
 * The live wedge (thinking A/B, scenario-onboarding): with extended
 * thinking on, the model batched a gated `propose_create_theme`
 * (needsApproval → the SDK PAUSES + surfaces a tool-approval-request) with
 * a NON-gated `propose_site_import` (a DB-propose tool that returns its own
 * result) in ONE turn. Pre-fix, the approval branch ran BEFORE dispatch and
 * short-circuited (continue on auto-approve / break on pause), so the
 * non-gated call's tool_use was left with neither a tool_result nor a
 * tool-approval-response. The SDK then 400'd on the next provider call
 * ("Tool result is missing for tool call …"), the turn failed, and the
 * import proposal was silently lost (onboarding asserted "0 proposals").
 *
 * Fix: dispatch every non-gated co-emitted call FIRST; handle the gated
 * approval afterwards. Same stub style as loop-toolcall-pairing.test.ts.
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

const NONGATED_ID = "toolu_nongated_site_import";
const GATED_ID = "toolu_gated_create_theme";

/**
 * One turn: a non-gated `propose_site_import` tool-call PLUS a gated
 * `propose_create_theme` surfaced as a tool-approval-request, then a
 * tool_use stop. The mixed-turn shape thinking produced.
 */
class MixedGatedTurnProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-mixed-gated-turn";

  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    yield {
      kind: "tool-call",
      id: NONGATED_ID,
      name: "propose_site_import",
      arguments: { sourceUrl: "https://example.com" },
    };
    yield {
      kind: "tool-approval-request",
      approvalId: "appr-theme-1",
      toolCallId: GATED_ID,
      name: "propose_create_theme",
      arguments: { name: "Brandy" },
    };
    yield { kind: "usage", inputTokens: 1500, outputTokens: 400, cachedTokens: 0 };
    yield { kind: "done", stopReason: "tool_use" };
  }
}

interface AppendedMessage {
  role: string;
  content: string;
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

async function runLoop(
  provider: AIProvider,
  fixture: ReturnType<typeof buildFixtureQueryApi>,
): Promise<{ events: ClientEvent[]; result: ToolLoopResult; dispatched: string[] }> {
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const dispatched: string[] = [];
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools: {
      dispatch: async (name: string) => {
        dispatched.push(name);
        return { ok: true, content: `Queued proposal for ${name}.` };
      },
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-mixed-gated",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [],
    initialMessages: [{ role: "user", content: "migrate my site + set a brand theme" }],
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
    if (step.done) return { events, result: step.value, dispatched };
    events.push(step.value);
  }
}

describe("runToolLoop — mixed gated + non-gated turn pairing", () => {
  it("dispatches the non-gated co-emitted call and pauses on the gated one", async () => {
    // Production pause path (no CAELO_E2E_AUTO_APPROVE_PROPOSALS): the turn
    // dispatches the non-gated call, then surfaces the gated approval and
    // stops. Ensure the env flag is off so we hit the pause branch.
    const prev = process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS;
    process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = undefined as unknown as string;
    delete process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS;
    try {
      const fixture = buildFixtureQueryApi();
      const { events, result, dispatched } = await runLoop(new MixedGatedTurnProvider(), fixture);

      // The non-gated call was actually dispatched (not skipped by the
      // approval short-circuit) — this is the regression guard.
      expect(dispatched).toContain("propose_site_import");
      // The gated call is NOT dispatched by our loop (the SDK owns it).
      expect(dispatched).not.toContain("propose_create_theme");

      // Its tool_result is persisted, paired to the non-gated tool_use id.
      const toolResults = fixture.appended.filter((m) => m.role === "tool");
      const nonGatedResult = toolResults.find((m) => m.toolCallId === NONGATED_ID);
      expect(nonGatedResult).toBeDefined();
      // No dangling: the gated id must NOT have a (fabricated) tool_result.
      expect(toolResults.some((m) => m.toolCallId === GATED_ID)).toBe(false);

      // The gated call surfaced as an in-chat approval request, and the turn
      // paused awaiting the decision.
      const approvalEvents = events.filter((e) => e.kind === "tool-approval-request");
      expect(approvalEvents).toHaveLength(1);
      expect(result.stopReason).toBe("awaiting_approval");
    } finally {
      if (prev !== undefined) process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS = prev;
    }
  });
});
