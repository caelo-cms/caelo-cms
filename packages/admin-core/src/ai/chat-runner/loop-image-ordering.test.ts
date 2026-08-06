// SPDX-License-Identifier: MPL-2.0

/**
 * Run #8 live-edit CI — regression test for multimodal tool-result
 * ordering. When ONE assistant turn carries TWO image-returning tool
 * calls (the live scenario's parallel desktop + mobile
 * `screenshot_page`), the pre-fix loop pushed each image user-message
 * inline after its own tool result:
 *
 *   [assistant(tool_use A, B), tool A, user(image A), tool B, user(image B)]
 *
 * and the provider SDK rejected the next call with
 * AI_MissingToolResultsError — a user message may not appear before
 * every tool call of the turn has its result. The loop now defers image
 * messages until after ALL of the turn's tool results:
 *
 *   [assistant(tool_use A, B), tool A, tool B, user(image A), user(image B)]
 *
 * Provider + Query API are fixtures (no DB) — this exercises the loop's
 * message assembly only.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { ProviderEvent } from "../provider.js";
import { FixtureProvider } from "../providers/anthropic.js";
import { type ToolDefinitionWithHandler, ToolRegistry } from "../tools/dispatch.js";
import { runToolLoop } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** An image-returning tool standing in for screenshot_page. */
function imageTool(): ToolDefinitionWithHandler<Record<string, never>> {
  return {
    name: "fake_screenshot",
    description: "returns an image",
    schema: z.object({}).strict(),
    inputSchema: { type: "object" },
    handler: async () => ({
      ok: true,
      content: "Screenshot captured.",
      image: { base64: PNG_1PX, mediaType: "image/png" as const },
    }),
  };
}

/**
 * First step: TWO parallel image-tool calls. Second step ends the turn;
 * issue #442 — its request history is observed at the mock-model boundary
 * (FixtureProvider.seenPrompts), where the chat-runner's prepareStep
 * override lands.
 */
class ParallelImageToolProvider extends FixtureProvider {
  #steps = 0;

  constructor() {
    super([], "fixture-parallel-images");
  }

  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.#steps += 1;
    if (this.#steps === 1) {
      return [
        { kind: "tool-call", id: "call-a", name: "fake_screenshot", arguments: {} },
        { kind: "tool-call", id: "call-b", name: "fake_screenshot", arguments: {} },
        { kind: "usage", inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "both screenshots reviewed" },
      { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

function buildFixtureQueryApi(): { registry: OperationRegistry; adapter: DatabaseAdapter } {
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "chat.append_message",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ role: z.string(), content: z.string() }),
      output: z.looseObject({}),
      handler: async () => ok({ messageId: crypto.randomUUID() }),
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
  return { registry, adapter };
}

describe("runToolLoop — parallel image tool results stay ahead of image messages (run #8 live-edit)", () => {
  it("appends both tool results before the first image user message", async () => {
    const provider = new ParallelImageToolProvider();
    const { registry, adapter } = buildFixtureQueryApi();
    const tools = new ToolRegistry();
    tools.register(imageTool());

    const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
    const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
    const gen = runToolLoop({
      registry,
      adapter,
      humanCtx: ctx,
      aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
      provider,
      tools,
      options: {} as ChatRunnerOptions,
      runChatTurn: (() => {
        throw new Error("no subagents in this test");
      }) as unknown as RunChatTurnFn,
      chatSessionId: "cs-image-order",
      chatBranchId: "cb-1",
      abortSignal: undefined,
      systemChunks: "",
      filteredTools: [
        { name: "fake_screenshot", description: "returns an image", inputSchema: { type: "object" } },
      ],
      initialMessages: [{ role: "user", content: "screenshot desktop and mobile" }],
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
      if (step.done) break;
      events.push(step.value);
    }

    const history = provider.seenPrompts[1];
    expect(history).toBeDefined();
    // The LanguageModel-level prompt coalesces adjacent tool messages into
    // one message with multiple tool-result parts — expand per part so the
    // ordering invariant stays assertable, and skip the system message.
    const roleTrace = (history ?? []).flatMap((raw) => {
      const m = raw as { role?: string; content?: unknown };
      if (m.role === "system") return [];
      if (m.role !== "tool" || !Array.isArray(m.content)) return [m.role];
      return m.content.map((part) => `tool:${(part as { toolCallId?: string }).toolCallId}`);
    });
    // The invariant the provider SDK enforces: every tool result of the
    // turn precedes the first (image) user message.
    expect(roleTrace).toEqual(["user", "assistant", "tool:call-a", "tool:call-b", "user", "user"]);
    // Both image messages actually carry their image payload (a non-text
    // part — the SDK converts image attachments to file parts).
    const imageMessages = (history ?? []).filter((raw) => {
      const m = raw as { role?: string; content?: unknown };
      return (
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((part) => (part as { type?: string }).type !== "text")
      );
    });
    expect(imageMessages.length).toBe(2);
  });
});
