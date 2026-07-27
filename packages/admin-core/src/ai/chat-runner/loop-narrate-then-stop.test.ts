// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (redesign) — narrate-then-stop recovery, the RECOVER layer.
 *
 * The failure: the model engages the task (loads a skill, lists pages), then
 * ends a turn with prose announcing what it is about to do and NO tool call, so
 * nothing happens.
 *
 * Recovery runs in two stages and both are tested here:
 *   1. a cheap STRUCTURAL pre-filter — tools were used, nothing was written,
 *      the turn stopped on `end_turn`. It decides only whether stage 2 is worth
 *      a call, because "read the page, then answer" has the identical shape;
 *   2. a SEMANTIC judge that reads the operator's request, the tool names and
 *      the closing message. Stubbed here — the loop must respect its verdict,
 *      including its refusal to decide.
 *
 * The load-bearing case is `answers a question` below: read tool → answer →
 * `end_turn` matches the pre-filter exactly, and forcing there would make the
 * assistant act when the operator only asked something.
 *
 * Same fixture style as loop-same-tool-runaway.test.ts: provider + Query API
 * are stubs; this exercises the loop's control flow only.
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
import type { FilteredTool } from "./tool-catalogue.js";
import type { JudgeTurnCompleteness, TurnCompletenessInput } from "./turn-completeness-judge.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/** Records the `toolChoice` the loop sent on each provider call. */
abstract class RecordingProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture-narrate";
  calls = 0;
  readonly toolChoices: (GenerateInput["toolChoice"] | undefined)[] = [];
  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    this.calls++;
    this.toolChoices.push(input.toolChoice);
    yield* this.script(this.calls);
    yield { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
  }
  protected abstract script(call: number): Iterable<ProviderEvent>;
  generateObject(): never {
    throw new Error("the fixture provider never serves the judge — inject a stub");
  }
}

/** load_skill (meta) → narrates and stops → on the forced re-run, does the work. */
class NarrateThenStopProvider extends RecordingProvider {
  protected *script(call: number): Iterable<ProviderEvent> {
    if (call === 1) {
      yield { kind: "tool-call", id: "toolu_1", name: "load_skill", arguments: {} };
      yield { kind: "done", stopReason: "tool_use" };
      return;
    }
    if (call === 2) {
      yield {
        kind: "text-delta",
        text: "Ein site-weiter Footer gehört ins Layout — ich lege ihn an.",
      };
      yield { kind: "done", stopReason: "end_turn" };
      return;
    }
    if (call === 3) {
      // The forced re-run: the model emits the call it had only announced.
      yield { kind: "tool-call", id: "toolu_2", name: "add_module_to_layout", arguments: {} };
      yield { kind: "done", stopReason: "tool_use" };
      return;
    }
    // Closes with a summary. The write above already flipped `turnHasWritten`,
    // so the pre-filter no longer matches and the judge is not consulted.
    yield { kind: "text-delta", text: "Fertig — die Footer-Nav steht im Layout." };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

/** Reads the page, then answers — the shape the pre-filter cannot tell apart. */
class ReadThenAnswerProvider extends RecordingProvider {
  protected *script(call: number): Iterable<ProviderEvent> {
    if (call === 1) {
      yield { kind: "tool-call", id: "toolu_1", name: "get_page", arguments: {} };
      yield { kind: "done", stopReason: "tool_use" };
      return;
    }
    yield { kind: "text-delta", text: "Die Überschrift lautet aktuell „Willkommen“." };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

/** Narrates on every turn — proves the force is bounded to once. */
class AlwaysNarratesProvider extends RecordingProvider {
  protected *script(call: number): Iterable<ProviderEvent> {
    if (call === 1) {
      yield { kind: "tool-call", id: "toolu_1", name: "list_pages", arguments: {} };
      yield { kind: "done", stopReason: "tool_use" };
      return;
    }
    yield { kind: "text-delta", text: "I'll do it next." };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

/** Answers a question directly — zero tool calls all turn. */
class PlainAnswerProvider extends RecordingProvider {
  protected *script(): Iterable<ProviderEvent> {
    yield { kind: "text-delta", text: "Ein Modul ist ein wiederverwendbarer Baustein." };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

/** Does real work, then closes with a summary — the legitimate wrap-up. */
class WorkThenSummaryProvider extends RecordingProvider {
  protected *script(call: number): Iterable<ProviderEvent> {
    if (call === 1) {
      yield { kind: "tool-call", id: "toolu_1", name: "build_page", arguments: {} };
      yield { kind: "done", stopReason: "tool_use" };
      return;
    }
    yield { kind: "text-delta", text: "Fertig — die Startseite steht." };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

/**
 * A judge that answers from a fixed script and records what it was shown.
 * `null` models the "could not decide" outcome (no provider / bad response).
 */
function stubJudge(verdicts: readonly (boolean | null)[]): {
  fn: JudgeTurnCompleteness;
  seen: TurnCompletenessInput[];
} {
  const seen: TurnCompletenessInput[] = [];
  const fn: JudgeTurnCompleteness = async (input) => {
    const verdict = verdicts[seen.length] ?? true;
    seen.push(input);
    if (verdict === null) return null;
    return {
      finished: verdict,
      reason: "stub",
      providerName: "anthropic",
      model: "stub-judge",
      inputTokens: 1,
      outputTokens: 1,
    };
  };
  return { fn, seen };
}

function buildFixtureQueryApi(): { registry: OperationRegistry; adapter: DatabaseAdapter } {
  const registry = new OperationRegistry();
  const passthrough = (name: string, value: Record<string, unknown>) =>
    registry.register(
      defineOperation({
        name,
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.looseObject({}),
        output: z.looseObject({}),
        handler: async () => ok(value),
      }),
    );
  registry.register(
    defineOperation({
      name: "chat.append_message",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok({ messageId: "msg-1" }),
    }),
  );
  passthrough("imports.get_session_budget_state", { gate: null });
  passthrough("chat.lookup_tool_result", { cached: null });
  passthrough("chat.cache_tool_result", {});
  passthrough("chat.record_ai_call", {});
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter };
}

async function runLoop(
  provider: AIProvider,
  judge: JudgeTurnCompleteness,
  userRequest = "füge dem Layout eine Footer-Nav hinzu",
): Promise<ToolLoopResult> {
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const fixture = buildFixtureQueryApi();
  // A non-empty catalogue: the guard requires tools to exist before it can
  // demand one be called.
  const filteredTools = [
    { name: "add_module_to_layout", description: "d", inputSchema: { type: "object" } },
  ] as unknown as FilteredTool[];
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools: { dispatch: async () => ({ ok: true, content: "done" }) } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-narrate",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools,
    initialMessages: [{ role: "user", content: userRequest }],
    compactionThresholdTokens: 600_000,
    judgeTurnCompleteness: judge,
    maxLoops: 50,
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
    if (step.done) return step.value;
    events.push(step.value);
  }
}

describe("runToolLoop — narrate-then-stop recovery", () => {
  it("forces a tool call when the judge says the announced work never happened", async () => {
    const provider = new NarrateThenStopProvider();
    const judge = stubJudge([false]);
    const result = await runLoop(provider, judge.fn);

    // load_skill → narration → forced re-run (work) → closing summary.
    expect(provider.calls).toBe(4);
    // ONLY the re-run carries the forcing parameter; every normal call stays
    // byte-identical to before this landed (prompt-cache safety).
    expect(provider.toolChoices).toEqual([undefined, undefined, "required", undefined]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);

    // The judge ran once — on the narration. The closing summary follows a
    // write, so the pre-filter stopped it before a second (billable) call.
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]?.userRequest).toBe("füge dem Layout eine Footer-Nav hinzu");
    expect(judge.seen[0]?.toolNames).toEqual(["load_skill"]);
    expect(judge.seen[0]?.assistantText).toContain("ich lege ihn an");
  });

  it("never forces when the judge says a read-then-answer turn is complete", async () => {
    // The regression this whole redesign turns on: structurally identical to
    // narrate-then-stop (read tool, no write, `end_turn`), but the operator
    // only asked a question. Forcing here would edit the site unbidden.
    const provider = new ReadThenAnswerProvider();
    const judge = stubJudge([true]);
    const result = await runLoop(
      provider,
      judge.fn,
      "wie lautet die aktuelle Überschrift auf der Startseite?",
    );

    expect(provider.calls).toBe(2);
    expect(provider.toolChoices).toEqual([undefined, undefined]);
    expect(result.stopReason).toBe("end_turn");

    // It reached the judge (the pre-filter cannot decide this) and the judge's
    // "finished" verdict is what stopped the force.
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]?.toolNames).toEqual(["get_page"]);
  });

  it("does not force when the judge cannot decide", async () => {
    // No provider for the judge model, a malformed verdict, or a provider
    // error. Declining restores the pre-guard behaviour; forcing on a guess
    // could change the site for a turn that was already complete.
    const provider = new ReadThenAnswerProvider();
    const judge = stubJudge([null]);
    const result = await runLoop(provider, judge.fn);

    expect(provider.calls).toBe(2);
    expect(provider.toolChoices).toEqual([undefined, undefined]);
    expect(result.stopReason).toBe("end_turn");
    expect(judge.seen).toHaveLength(1);
  });

  it("never reaches the judge when the turn made no tool calls at all", async () => {
    const provider = new PlainAnswerProvider();
    const judge = stubJudge([false]);
    const result = await runLoop(provider, judge.fn);

    expect(provider.calls).toBe(1);
    expect(provider.toolChoices).toEqual([undefined]);
    expect(result.stopReason).toBe("end_turn");
    // Not even a billable judge call: nothing was engaged, so there is no
    // dropped intention to recover.
    expect(judge.seen).toHaveLength(0);
  });

  it("never reaches the judge for a closing summary that follows real work", async () => {
    const provider = new WorkThenSummaryProvider();
    const judge = stubJudge([false]);
    const result = await runLoop(provider, judge.fn);

    // build_page counted as a write, so the text-only turn is a wrap-up and
    // the pre-filter short-circuits before the judge.
    expect(provider.calls).toBe(2);
    expect(provider.toolChoices).toEqual([undefined, undefined]);
    expect(result.stopReason).toBe("end_turn");
    expect(judge.seen).toHaveLength(0);
  });

  it("forces at most once per turn", async () => {
    const provider = new AlwaysNarratesProvider();
    // The judge would keep saying "not finished"; the one-shot guard is what
    // ends the turn instead of ping-ponging with the model.
    const judge = stubJudge([false, false, false]);
    const result = await runLoop(provider, judge.fn);

    // list_pages → narration → ONE forced re-run → narrates again → stop.
    expect(provider.calls).toBe(3);
    expect(provider.toolChoices.filter((c) => c === "required")).toHaveLength(1);
    expect(result.stopReason).toBe("end_turn");
    // The second narration never reaches the judge — `forcedToolRetried`
    // short-circuits ahead of it, so a stuck model costs one judgment, not one
    // per loop.
    expect(judge.seen).toHaveLength(1);
  });
});
