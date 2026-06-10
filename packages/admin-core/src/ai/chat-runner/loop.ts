// SPDX-License-Identifier: MPL-2.0

/**
 * The chat-runner tool loop: repeatedly streams a provider turn, persists the
 * assistant message, runs the passive-turn recovery, and dispatches tool
 * calls until the model stops (or the loop cap / abort fires). Extracted
 * verbatim from the pre-split `chat-runner.ts`; `yield*`-delegated from
 * `runChatTurn` in `index.ts`. The `return` value carries the terminal state
 * the orchestrator needs for the epilogue.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import type { AIProvider, ChatMessageInput } from "../provider.js";
import {
  evaluateLoopZeroDiagnostics,
  PASSIVE_ACTION_NUDGE,
  shouldNudgePassiveTurn,
} from "./passive-turn.js";
import { persistAssistantTurn } from "./persistence.js";
import { streamProviderTurn, type UsageAccumulator } from "./streaming.js";
import type { FilteredTool } from "./tool-catalogue.js";
import { dispatchToolCall } from "./tool-dispatch.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn, StopReason } from "./types.js";

export interface ToolLoopResult {
  stopReason: StopReason;
  succeeded: boolean;
  lastAssistantMessageId: string | null;
}

export interface ToolLoopArgs {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  humanCtx: ExecutionContext;
  aiCtxWithBranch: ExecutionContext;
  provider: AIProvider;
  tools: ChatRunnerOptions["tools"];
  options: ChatRunnerOptions;
  runChatTurn: RunChatTurnFn;
  chatSessionId: string;
  chatBranchId: string;
  abortSignal: AbortSignal | undefined;
  systemChunks: Parameters<AIProvider["generate"]>[0]["systemPrompt"];
  filteredTools: FilteredTool[];
  initialMessages: ChatMessageInput[];
  maxLoops: number;
  maxOutputTokens: number;
  temperature: number | undefined;
  thinkingBudget: number | null;
  usage: UsageAccumulator;
  costCapMicrocents: number | undefined;
  inputCost: number;
  outputCost: number;
}

export async function* runToolLoop(
  args: ToolLoopArgs,
): AsyncGenerator<ClientEvent, ToolLoopResult> {
  const { registry, adapter, humanCtx, provider, tools, options, chatSessionId } = args;
  const abortSignal = args.abortSignal;
  const aborted = (): boolean => abortSignal?.aborted === true;

  let messages = [...args.initialMessages];
  let succeeded = true;
  let stopReason: StopReason = "end_turn";
  let lastAssistantMessageId: string | null = null;
  // v0.3.20 — track the most recent loopStop so we can detect the
  // cap-exhaustion case (for-loop ran to completion without breaking).
  let lastLoopStop: StopReason | null = null;
  // issue #106 — one-shot guard for the passive-turn nudge.
  let passiveNudged = false;

  for (let loop = 0; loop < args.maxLoops; loop++) {
    if (aborted()) break;

    const {
      accumulatedText,
      accumulatedToolCalls,
      accumulatedThinking,
      loopStop,
      providerErr,
      stoppingDiagnostics,
    } = yield* streamProviderTurn({
      provider,
      systemPrompt: args.systemChunks,
      messages,
      tools: args.filteredTools,
      abortSignal,
      maxTokens: args.maxOutputTokens,
      temperature: args.temperature,
      thinkingBudget: args.thinkingBudget,
      usage: args.usage,
      costCapMicrocents: args.costCapMicrocents,
      inputCost: args.inputCost,
      outputCost: args.outputCost,
    });
    if (providerErr) {
      succeeded = false;
      stopReason = "error";
      break;
    }

    const assistantContent = accumulatedText.join("");
    const saved = await persistAssistantTurn(registry, adapter, humanCtx, {
      chatSessionId,
      content: assistantContent,
      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : null,
      // v0.2.54 — persist thinking blocks alongside the assistant turn.
      thinkingBlocks: accumulatedThinking.length > 0 ? accumulatedThinking : null,
      status: aborted() ? "interrupted" : "complete",
    });
    if (saved.ok) {
      lastAssistantMessageId = saved.messageId;
      yield { kind: "assistant-message-saved", messageId: saved.messageId };
    } else if (saved.sessionGone) {
      // PR #61 follow-up — session row vanished mid-stream (Discard, fixture
      // reset, cascade delete). A normal race: log softly + terminate the
      // loop without an SSE error banner; no operator is on the stream.
      console.warn("[chat-runner] session gone mid-stream; terminating quietly", {
        chatSessionId,
      });
      stopReason = "session_gone";
      succeeded = false;
      break;
    } else {
      // v0.2.52 — Don't silently proceed to tool dispatch when the anchor
      // message wasn't persisted. Surface as an SSE error + a breadcrumb.
      console.error("[chat-runner] failed to persist assistant message", {
        chatSessionId,
        error: saved.message,
      });
      yield { kind: "error", message: `Failed to save assistant message: ${saved.message}` };
      stopReason = "error";
      succeeded = false;
      break;
    }

    // Update messages history for the potential next loop iteration.
    messages = [
      ...messages,
      {
        role: "assistant",
        content: assistantContent,
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        // v0.2.54 — round-trip thinking blocks; Anthropic verifies the
        // signatures on the next provider call after tool_results.
        ...(accumulatedThinking.length > 0 ? { thinkingBlocks: accumulatedThinking } : {}),
      },
    ];

    // v0.2.55 — Per-loop trace for postmortem.
    console.error("[chat-runner] loop", {
      chatSessionId,
      loop,
      loopStop,
      toolCalls: accumulatedToolCalls.length,
      toolNames: accumulatedToolCalls.map((c) => c.name),
      textChars: accumulatedText.join("").length,
      thinkingBlocks: accumulatedThinking.length,
      tokensIn: args.usage.totalIn,
      tokensOut: args.usage.totalOut,
    });

    // v0.10.16/.17/.21 — loop-0 zero-tool diagnostics.
    if (loop === 0 && accumulatedToolCalls.length === 0 && loopStop === "end_turn" && !aborted()) {
      const warning = evaluateLoopZeroDiagnostics({
        chatSessionId,
        accumulatedText,
        accumulatedThinking,
        totalIn: args.usage.totalIn,
        totalOut: args.usage.totalOut,
        stoppingDiagnostics,
      });
      if (warning) yield warning;
    }

    if (aborted()) break;
    lastLoopStop = loopStop;
    if (loopStop !== "tool_use" || accumulatedToolCalls.length === 0) {
      // issue #106 — passive-turn recovery. The model sometimes describes
      // the change it's about to make and ends the turn WITHOUT emitting the
      // tool call. Nudge once and re-run; the nudge rides in-memory only.
      if (
        shouldNudgePassiveTurn({
          passiveNudged,
          loop,
          loopStop,
          toolCallCount: accumulatedToolCalls.length,
          toolsAvailable: args.filteredTools.length,
          aborted: aborted(),
          text: accumulatedText.join(""),
        })
      ) {
        passiveNudged = true;
        console.error("[chat-runner] passive-action-nudge", {
          chatSessionId,
          textChars: accumulatedText.join("").length,
          rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
        });
        messages = [...messages, { role: "user", content: PASSIVE_ACTION_NUDGE }];
        continue;
      }
      stopReason = loopStop;
      break;
    }

    // Dispatch each tool call sequentially and append a tool result.
    // P5.2 #3 — dedupe by (chat_session_id, tool_call_id).
    for (const call of accumulatedToolCalls) {
      if (aborted()) break;
      yield* dispatchToolCall(call, messages, {
        registry,
        adapter,
        humanCtx,
        aiCtxWithBranch: args.aiCtxWithBranch,
        provider,
        tools,
        chatSessionId,
        chatBranchId: args.chatBranchId,
        options,
        runChatTurn: args.runChatTurn,
      });
    }
  }

  // v0.3.20 — cap-exhaustion notice. If the for-loop ran to completion AND
  // the last iteration ended with the AI still wanting to call more tools,
  // we hit `maxLoops`. Surface a clear user-visible message.
  if (lastLoopStop === "tool_use" && !aborted()) {
    stopReason = "max_loops";
    const notice =
      `Paused at the tool-loop limit (${args.maxLoops} iterations). The build was still in progress — ` +
      `reply "continue" to resume.`;
    console.error("[chat-runner] max_loops cap hit", { chatSessionId, maxLoops: args.maxLoops });
    yield { kind: "text-delta", text: notice };
    const noticeSave = await execute(registry, adapter, humanCtx, "chat.append_message", {
      chatSessionId,
      role: "assistant",
      content: notice,
      status: "complete",
    });
    if (noticeSave.ok) {
      lastAssistantMessageId = (noticeSave.value as { messageId: string }).messageId;
      yield { kind: "assistant-message-saved", messageId: lastAssistantMessageId };
    }
  }

  return { stopReason, succeeded, lastAssistantMessageId };
}
