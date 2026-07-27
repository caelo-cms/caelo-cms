// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (redesign) — narrate-then-stop recovery, the RECOVER layer.
 *
 * The failure: the model engages the task (loads a skill, lists pages), then
 * ends a turn with prose announcing what it is about to do and NO tool call, so
 * nothing happens. The old guard tried to recognise that prose with an
 * English-only regex and injected a synthetic `role:"user"` nudge; this one is
 * structural and recovers through the provider's own `toolChoice`.
 *
 * What must hold:
 *   - engaged (read/meta only) then text-only stop → ONE re-run carrying
 *     `toolChoice: "required"`, after which the work lands;
 *   - a plain answer with zero tool calls all turn → never forced (this is what
 *     makes ordinary Q&A safe);
 *   - a text-only turn AFTER real work → never forced (that is a wrap-up
 *     summary; forcing would be a false accusation and invite duplicate work);
 *   - the force is once per turn, so a model that narrates again is not looped.
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
    // so this text-only stop must NOT be forced again.
    yield { kind: "text-delta", text: "Fertig — die Footer-Nav steht im Layout." };
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
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter };
}

async function runLoop(provider: AIProvider): Promise<ToolLoopResult> {
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
    initialMessages: [{ role: "user", content: "füge dem Layout eine Footer-Nav hinzu" }],
    compactionThresholdTokens: 600_000,
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
  it("forces a tool call after read/meta-only engagement, and the work lands", async () => {
    const provider = new NarrateThenStopProvider();
    const result = await runLoop(provider);

    // load_skill → narration → forced re-run (work) → closing summary.
    expect(provider.calls).toBe(4);
    // ONLY the re-run carries the forcing parameter; every normal call stays
    // byte-identical to before this landed (prompt-cache safety). The closing
    // summary is not forced again — the write flipped `turnHasWritten`.
    expect(provider.toolChoices).toEqual([undefined, undefined, "required", undefined]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.succeeded).toBe(true);
  });

  it("never forces when the turn made no tool calls at all (plain Q&A)", async () => {
    const provider = new PlainAnswerProvider();
    const result = await runLoop(provider);

    expect(provider.calls).toBe(1);
    expect(provider.toolChoices).toEqual([undefined]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("never forces a closing summary that follows real work", async () => {
    const provider = new WorkThenSummaryProvider();
    const result = await runLoop(provider);

    // build_page counted as a write, so the text-only turn is a wrap-up.
    expect(provider.calls).toBe(2);
    expect(provider.toolChoices).toEqual([undefined, undefined]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("forces at most once per turn", async () => {
    const provider = new AlwaysNarratesProvider();
    const result = await runLoop(provider);

    // list_pages → narration → ONE forced re-run → narrates again → stop.
    // The second narration does NOT get a second force, so the loop ends
    // instead of ping-ponging with the model.
    expect(provider.calls).toBe(3);
    expect(provider.toolChoices.filter((c) => c === "required")).toHaveLength(1);
    expect(result.stopReason).toBe("end_turn");
  });
});
