// SPDX-License-Identifier: MPL-2.0

/**
 * Orchestrates a single user→AI turn:
 *   1. Persist the user message + chips.
 *   2. Build messages history + system prompt (chunked for prompt-cache).
 *   3. Run the tool loop (see `loop.ts`): stream provider → persist assistant
 *      text + tool_calls → dispatch tools → repeat while `stop_reason=tool_use`.
 *   4. Record one ai_calls row aggregating usage across the loop.
 *
 * P5.2: `abortSignal` propagates to the provider stream and every yield site;
 * tool dispatch is deduped by (chat_session_id, tool_call_id) so a runner
 * re-entry can't mutate the same module twice; `composeSystemPromptChunks`
 * returns ordered chunks the Anthropic adapter caches selectively.
 *
 * This file is the orchestration entry point of the `chat-runner/` split
 * (issue #15); per-concern logic lives in the sibling modules. The pre-split
 * `../chat-runner.ts` is now a thin re-export shim onto this module.
 */

import type { ChatSendMessageInput, ExecutionContext } from "@caelo-cms/shared";

import type { ChatMessageInput } from "../provider.js";
import { composeSystemPromptChunks } from "../system-prompt.js";
import { buildToolDescribeState } from "../tools/describe-state.js";
import { buildPostCatalogueBlocks } from "./context/skills.js";
import { buildSystemContextBlocks } from "./context-blocks.js";
import {
  DEFAULT_INPUT_COST_PER_M,
  DEFAULT_OUTPUT_COST_PER_M,
  finalUsdCost,
  MAX_OUTPUT_TOKENS_DEFAULT,
} from "./limits.js";
import { runToolLoop } from "./loop.js";
import {
  loadMemory,
  loadSession,
  markInterrupted,
  persistUserMessage,
  recordAiCall,
} from "./persistence.js";
import type { UsageAccumulator } from "./streaming.js";
import { buildToolCatalogue } from "./tool-catalogue.js";
import type { AccumulatedToolCall, ChatRunnerOptions, ClientEvent } from "./types.js";

export { isLegitimateTextOnlyTurn } from "./passive-turn.js";
// Public surface re-exports — the `../chat-runner.ts` shim does `export *`
// from here, so these keep the pre-split import paths working.
export type { ChatRunnerOptions, ClientEvent } from "./types.js";

export async function* runChatTurn(
  options: ChatRunnerOptions,
  input: ChatSendMessageInput,
): AsyncIterable<ClientEvent> {
  const { adapter, registry, provider, tools, aiCtx, humanCtx, abortSignal } = options;
  const inputCost = options.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
  const outputCost = options.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
  // v0.3.20 — raised from 5 to 25. Multi-section authoring sessions
  // routinely need >5 tool-use round-trips; see the cap-exhaustion notice
  // in loop.ts for the visible-signal half of the fix.
  const maxLoops = options.maxToolLoops ?? 25;
  const startedAt = Date.now();
  const aborted = (): boolean => abortSignal?.aborted === true;
  // v0.2.57 — entry breadcrumb on console.error so Bun + SvelteKit's stdout
  // path (which swallows console.info/log in production) doesn't drop it.
  console.error("[chat-runner] enter", {
    chatSessionId: input.chatSessionId,
    actorKind: aiCtx.actorKind,
    maxLoops,
    maxOutputTokens: options.maxOutputTokens,
  });

  // 1. Persist the user message.
  if (!(await persistUserMessage(registry, adapter, humanCtx, input))) {
    yield { kind: "error", message: "failed to persist user message" };
    yield { kind: "done" };
    return;
  }

  // 2. Load memory + history.
  const memory = await loadMemory(registry, adapter, humanCtx);
  const session = await loadSession(registry, adapter, humanCtx, input.chatSessionId);
  if (!session) {
    yield { kind: "error", message: "failed to load session" };
    yield { kind: "done" };
    return;
  }

  // v0.9.0 — branch-aware ctx for every downstream read so the AI's
  // pages.list / layouts.list / templates.list / pages.get etc. include the
  // chat's own branched-create entities.
  const humanCtxWithBranch: ExecutionContext = {
    ...humanCtx,
    chatBranchId: session.session.chatBranchId,
    chatTaskId: input.chatSessionId,
  };

  // v0.2.54 — Resolve extended-thinking config for THIS turn. Per-chat-session
  // toggle wins; budget falls back to a default under the 32k max_tokens floor.
  const thinkingEnabled = session.session.extendedThinkingEnabled;
  const thinkingBudget = thinkingEnabled
    ? (session.session.extendedThinkingBudgetTokens ?? 10000)
    : null;
  console.error("[chat-runner] session", {
    chatSessionId: input.chatSessionId,
    thinkingEnabled,
    thinkingBudget,
    historyLen: session.messages.length,
    chips: input.chips.length,
  });

  // Provider message history is everything in the chat now (the user message
  // we just appended is in there too). v0.2.54 — prior thinking blocks are
  // included so Anthropic can verify signatures across tool-use boundaries.
  const baseMessages: ChatMessageInput[] = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: Array.isArray(m.toolCalls) ? (m.toolCalls as AccumulatedToolCall[]) : undefined,
    toolCallId: m.toolCallId ?? undefined,
    ...(m.thinkingBlocks && m.thinkingBlocks.length > 0
      ? { thinkingBlocks: m.thinkingBlocks }
      : {}),
  }));

  // Build all pre-catalogue system-prompt context blocks + skill engagement.
  const ctx = await buildSystemContextBlocks({
    registry,
    adapter,
    humanCtx,
    humanCtxWithBranch,
    aiActorId: aiCtx.actorId,
    input,
  });

  // v0.6.0 W1 — assemble ToolDescribeState from the layouts/templates/
  // site_defaults values fetched for the system-prompt blocks.
  const toolDescribeState = buildToolDescribeState({
    actor: { actorId: aiCtx.actorId, actorKind: aiCtx.actorKind },
    layoutsValue: ctx.layoutsValue,
    templatesValue: ctx.templatesValue,
    siteDefaultsValue: ctx.siteDefaultsValue,
    // v0.12.3 (issue #106) — feeds the per-page blockName enum.
    activePage: ctx.activePageForState,
  });

  // P10A skill allowlist intersection ∪ P10.5 subagent exclusion.
  const filteredTools = buildToolCatalogue({
    tools,
    toolDescribeState,
    allowedToolNames: ctx.allowedToolNames,
    engagedSkills: ctx.engagedSkills,
    excluded: options.excludedToolNames,
    chatSessionId: input.chatSessionId,
  });

  // Blocks that depend on the filtered catalogue (subagents / plugins).
  const postBlocks = await buildPostCatalogueBlocks({
    registry,
    adapter,
    aiCtx,
    filteredTools,
    excluded: options.excludedToolNames,
    userMessage: input.content,
    skillsBlock: ctx.preBlocks.skillsBlock,
  });

  const systemChunks = composeSystemPromptChunks(
    memory,
    filteredTools.map((t) => ({ name: t.name, description: t.description })),
    {
      ...ctx.preBlocks,
      subagentsBlock: postBlocks.subagentsBlock,
      pluginsBlock: postBlocks.pluginsBlock,
      pluginContextBlock: postBlocks.pluginContextBlock,
    },
  );

  // AI calls all run with chatBranchId set so the snapshot lands tagged.
  const aiCtxWithBranch: ExecutionContext = {
    ...aiCtx,
    chatBranchId: session.session.chatBranchId,
    chatTaskId: input.chatSessionId,
  };

  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };

  // 3. Run the tool loop.
  const { stopReason, succeeded, lastAssistantMessageId } = yield* runToolLoop({
    registry,
    adapter,
    humanCtx,
    aiCtxWithBranch,
    provider,
    tools,
    options,
    runChatTurn,
    chatSessionId: input.chatSessionId,
    chatBranchId: session.session.chatBranchId,
    abortSignal,
    systemChunks,
    filteredTools,
    initialMessages: baseMessages,
    maxLoops,
    maxOutputTokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS_DEFAULT,
    temperature: options.temperature,
    thinkingBudget,
    usage,
    costCapMicrocents: options.costCapMicrocents,
    inputCost,
    outputCost,
  });

  if (aborted() && lastAssistantMessageId) {
    await markInterrupted(registry, adapter, humanCtx, lastAssistantMessageId);
  }

  const usdCost = finalUsdCost(usage.totalIn, usage.totalOut, inputCost, outputCost);
  yield {
    kind: "usage",
    inputTokens: usage.totalIn,
    outputTokens: usage.totalOut,
    cachedTokens: usage.totalCached,
    cost: usdCost,
  };

  // 4. Record one ai_calls row aggregating usage across the loop.
  await recordAiCall(registry, adapter, humanCtx, {
    chatSessionId: input.chatSessionId,
    provider: provider.name,
    model: provider.model,
    inputTokens: usage.totalIn,
    outputTokens: usage.totalOut,
    cachedTokens: usage.totalCached,
    // P16 — canonical price comes from the ai_pricing table inside the op.
    durationMs: Date.now() - startedAt,
    succeeded: succeeded && stopReason !== "error" && !aborted(),
    // P10.5 — parent attribution flows through aiCtx for subagent turns.
    parentChatSessionId: aiCtx.parentChatSessionId,
    parentAiCallId: aiCtx.parentAiCallId,
    // P16 — request_id flows through aiCtx if hooks.server.ts threaded it.
    requestId: aiCtx.requestId ?? null,
  });

  if (aborted()) {
    yield { kind: "interrupted", messageId: lastAssistantMessageId };
  }
  yield { kind: "done" };
}
