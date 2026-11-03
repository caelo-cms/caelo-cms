// SPDX-License-Identifier: MPL-2.0

/**
 * #991 — a tool result that loads deferred tools (`ToolResult.
 * toolReferences`, set by load_skill) reaches the NEXT step of the same
 * turn as `tool_reference` parts, so the model can call the skill's tools
 * without a tool-search pass. Before, load_skill loaded none of them: the
 * model either searched (#809: a whole extra model pass per search) or
 * called a loaded tool in place of the deferred one (`bug_report` with
 * "placeholder" values, e2e-livedit 2026-10).
 *
 * Provider + Query API are fixtures (no DB); the step prompts are observed
 * at the mock-model boundary (`FixtureProvider.seenPrompts`).
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { ProviderEvent } from "../provider.js";
import { FixtureProvider } from "../providers/anthropic.js";
import type { ToolResult } from "../tools/dispatch.js";
import type { ToolRegistry } from "../tools/index.js";
import { runToolLoop } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import { toolReferenceMessages } from "./tool-dispatch.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

/** Step 1 loads a skill (optionally next to a list_pages call); step 2 ends the turn. */
class SkillLoadingProvider extends FixtureProvider {
  private calls = 0;

  constructor(
    deferred: ReadonlySet<string>,
    private readonly parallel = false,
  ) {
    super([], "fixture-skill-loading");
    this.deferred = deferred;
  }

  protected override nextStepEvents(): readonly ProviderEvent[] {
    if (this.calls++ === 0) {
      return [
        { kind: "tool-call", id: "t-skill", name: "load_skill", arguments: { slugs: ["x"] } },
        ...(this.parallel
          ? [{ kind: "tool-call", id: "t-pages", name: "list_pages", arguments: {} } as const]
          : []),
        { kind: "usage", inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "done" },
      { kind: "usage", inputTokens: 100, outputTokens: 5, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

interface Appended {
  role: string;
  content: string;
  toolCallId: string | null;
  responseMessages: unknown[] | null;
}

function fixtureQueryApi(): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  appended: Appended[];
  cached: string[];
} {
  const appended: Appended[] = [];
  const cached: string[] = [];
  const registry = new OperationRegistry();
  const stub = (name: string, value: unknown) =>
    defineOperation({
      name,
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () => ok(value as Record<string, unknown>),
    });
  registry.register(
    defineOperation({
      name: "chat.append_message",
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ role: z.string(), content: z.string() }),
      output: z.looseObject({}),
      handler: async (_ctx, input) => {
        appended.push({
          role: input.role,
          content: input.content,
          toolCallId: (input.toolCallId as string | undefined) ?? null,
          responseMessages: (input.responseMessages as unknown[] | undefined) ?? null,
        });
        return ok({ messageId: `msg-${appended.length}` });
      },
    }),
  );
  registry.register(stub("chat.set_response_messages", { updated: true }));
  registry.register(stub("chat.lookup_tool_result", { cached: null }));
  registry.register(
    defineOperation({
      name: "chat.cache_tool_result",
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({ toolCallId: z.string() }),
      output: z.looseObject({}),
      handler: async (_ctx, input) => {
        cached.push(input.toolCallId);
        return ok({});
      },
    }),
  );
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter, appended, cached };
}

async function runTurn(provider: FixtureProvider, result: ToolResult) {
  const results: Record<string, ToolResult> = {
    load_skill: result,
    list_pages: { ok: true, content: "no pages yet" },
  };
  const fixture = fixtureQueryApi();
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools: {
      dispatch: async (name: string) => results[name] ?? { ok: false, content: "unknown" },
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-refs",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: [
      { name: "load_skill", description: "fixture", inputSchema: { type: "object" } },
      { name: "set_theme_tokens", description: "fixture", inputSchema: { type: "object" } },
      { name: "list_pages", description: "fixture", inputSchema: { type: "object" } },
    ],
    initialMessages: [{ role: "user", content: "build the homepage" }],
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
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
    if (step.done) {
      return { events, loop: step.value, appended: fixture.appended, cached: fixture.cached };
    }
    events.push(step.value);
  }
}

/** The tool-result part answering `toolCallId` in one step's prompt. */
function toolResultPart(prompt: readonly unknown[] | undefined, toolCallId: string) {
  for (const msg of prompt ?? []) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = part as { type?: string; toolCallId?: string; output?: unknown };
      if (p.type === "tool-result" && p.toolCallId === toolCallId) return p;
    }
  }
  return undefined;
}

const SKILL_TEXT = 'Loaded skill "x" — follow it.';
const REFERENCE = {
  type: "custom",
  providerOptions: { anthropic: { type: "tool-reference", toolName: "set_theme_tokens" } },
};

/** Role + tool-call id (tool messages) of every message in one step's prompt. */
function shape(prompt: readonly unknown[] | undefined): string[] {
  return (prompt ?? []).map((msg) => {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "tool" || !Array.isArray(m.content)) return m.role ?? "?";
    const ids = m.content.map((p) => (p as { toolCallId?: string }).toolCallId).join(",");
    return `tool:${ids}`;
  });
}

/** The text of the last user message in one step's prompt. */
function lastUserText(prompt: readonly unknown[] | undefined): string | undefined {
  const users = (prompt ?? []).filter((m) => (m as { role?: string }).role === "user");
  const last = users.at(-1) as { content?: unknown } | undefined;
  const parts = Array.isArray(last?.content) ? (last.content as { text?: string }[]) : [];
  return parts.map((p) => p.text ?? "").join("");
}

describe("runToolLoop — tool references from load_skill (#991)", () => {
  it("sends the deferred tools as a references-only tool result, the text after it", async () => {
    const provider = new SkillLoadingProvider(new Set(["set_theme_tokens"]));
    const { loop, appended, cached } = await runTurn(provider, {
      ok: true,
      content: SKILL_TEXT,
      // build_page is not deferred in this request: referencing it would add
      // nothing, and a tool the request lacks would fail it.
      toolReferences: ["set_theme_tokens", "build_page"],
    });
    expect(loop.succeeded).toBe(true);
    expect(provider.seenPrompts.length).toBe(2);
    const step2 = provider.seenPrompts[1];
    // The API refuses text next to tool references in one tool result.
    expect(toolResultPart(step2, "t-skill")?.output).toEqual({
      type: "content",
      value: [REFERENCE],
    });
    expect(shape(step2).slice(-2)).toEqual(["tool:t-skill", "user"]);
    expect(lastUserText(step2)).toBe(SKILL_TEXT);
    // Persisted as the SDK's messages, so later turns replay the same bytes
    // (and the tools stay expanded) without a rebuild.
    const row = appended.find((a) => a.role === "tool" && a.toolCallId === "t-skill");
    expect(row?.content).toBe(SKILL_TEXT);
    const stored = toolReferenceMessages(
      { id: "t-skill", name: "load_skill" },
      { content: SKILL_TEXT, toolReferences: ["set_theme_tokens"] },
      { names: new Set(), deferred: new Set(["set_theme_tokens"]) },
    );
    expect(row?.responseMessages).toEqual([stored?.toolMessage, stored?.followUp]);
    // The dedup cache keeps text only; a cached replay would lose the
    // references, so this read-only result is not cached.
    expect(cached).not.toContain("t-skill");
  });

  it("puts the text after EVERY tool result of the step, not between them", async () => {
    const provider = new SkillLoadingProvider(new Set(["set_theme_tokens"]), true);
    const { loop } = await runTurn(provider, {
      ok: true,
      content: SKILL_TEXT,
      toolReferences: ["set_theme_tokens"],
    });
    expect(loop.succeeded).toBe(true);
    // The SDK merges the step's tool messages into one; the text follows it.
    expect(shape(provider.seenPrompts[1]).slice(-2)).toEqual(["tool:t-skill,t-pages", "user"]);
  });

  it("keeps a plain text result when the provider defers nothing", async () => {
    const provider = new SkillLoadingProvider(new Set());
    const { appended } = await runTurn(provider, {
      ok: true,
      content: SKILL_TEXT,
      toolReferences: ["set_theme_tokens"],
    });
    const part = toolResultPart(provider.seenPrompts[1], "t-skill");
    expect(part?.output).toEqual({ type: "text", value: SKILL_TEXT });
    const row = appended.find((a) => a.role === "tool" && a.toolCallId === "t-skill");
    expect(row?.responseMessages).toBeNull();
  });
});
