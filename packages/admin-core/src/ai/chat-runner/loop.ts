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
  compactHistory,
  estimateHistoryTokens,
  KEEP_RECENT_MESSAGES,
  parsePromptTooLongLimit,
  RETRY_TOOL_RESULT_HEAD_CHARS,
  TOOL_RESULT_HEAD_CHARS,
} from "./compaction.js";
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
  /**
   * issue #261 — history-size ceiling (estimated tokens) above which
   * the loop compacts before calling the provider. Threaded from
   * `resolveCompactionThresholdTokens()` in index.ts.
   */
  compactionThresholdTokens: number;
  /**
   * Run #10 D5 — first-event watchdog window override (tests). Absent
   * ⇒ streaming.ts resolves the env-tunable default (180s).
   */
  firstEventTimeoutMs?: number;
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
  // issue #261 — one-shot guard for the prompt-too-long compact+retry.
  let promptTooLongRetried = false;
  // Run #10 D5 — one-shot guard for the first-event-timeout retry.
  let firstEventTimeoutRetried = false;
  // Run #8 R1 — one-shot guard for the empty-content-at-output-cap retry.
  let emptyAtCapRetried = false;
  // Run #8 R1 — the retry raises the per-call ceiling (adaptive thinking
  // consumed the whole budget before any visible content; re-running at
  // the same ceiling would likely fail identically).
  let maxOutputTokensThisTurn = args.maxOutputTokens;

  for (let loop = 0; loop < args.maxLoops; loop++) {
    if (aborted()) break;

    // issue #261 — pre-flight compaction. Estimated on every iteration
    // because tool results appended mid-loop grow the history between
    // provider calls, not just between operator turns. Compacts the
    // in-memory provider history only; the persisted transcript is
    // untouched.
    const preflightEstimate = estimateHistoryTokens(messages);
    if (preflightEstimate > args.compactionThresholdTokens) {
      const compacted = compactHistory(messages, {
        targetTokens: args.compactionThresholdTokens,
        keepRecentMessages: KEEP_RECENT_MESSAGES,
        toolResultHeadChars: TOOL_RESULT_HEAD_CHARS,
      });
      messages = compacted.messages;
      console.error("[chat-runner] history-compacted", {
        chatSessionId,
        loop,
        estimatedTokensBefore: compacted.estimatedTokensBefore,
        estimatedTokensAfter: compacted.estimatedTokensAfter,
        toolResultsTruncated: compacted.toolResultsTruncated,
        summarizedMessages: compacted.summarizedMessages,
      });
    }

    const {
      accumulatedText,
      accumulatedToolCalls,
      accumulatedThinking,
      loopStop,
      providerErr,
      promptTooLongMessage,
      firstEventTimedOut,
      stoppingDiagnostics,
    } = yield* streamProviderTurn({
      provider,
      systemPrompt: args.systemChunks,
      messages,
      tools: args.filteredTools,
      abortSignal,
      maxTokens: maxOutputTokensThisTurn,
      temperature: args.temperature,
      thinkingBudget: args.thinkingBudget,
      usage: args.usage,
      costCapMicrocents: args.costCapMicrocents,
      inputCost: args.inputCost,
      outputCost: args.outputCost,
      ...(args.firstEventTimeoutMs !== undefined
        ? { firstEventTimeoutMs: args.firstEventTimeoutMs }
        : {}),
    });
    if (providerErr) {
      // Run #10 D5 — the provider produced ZERO stream events inside
      // the watchdog window (hung request / dead upstream). One
      // automatic retry replaces the silent call; a second silence in
      // a row becomes a VISIBLE persisted notice — never the run #10
      // shape where keep-alives masked a hung call for 12 minutes.
      if (firstEventTimedOut && !aborted()) {
        if (!firstEventTimeoutRetried) {
          firstEventTimeoutRetried = true;
          console.error("[chat-runner] first-event-timeout-retry", { chatSessionId, loop });
          // The retry replaces the failed call — don't burn a loop slot
          // on a call that never produced anything.
          loop--;
          continue;
        }
        const notice =
          "The AI provider did not start responding (no data at all) within the timeout window, " +
          "twice in a row. This is a provider/network hang, not a content problem — please send " +
          "your message again in a moment.";
        console.error("[chat-runner] first-event-timeout-unrecovered", { chatSessionId, loop });
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
        yield { kind: "error", message: notice };
        succeeded = false;
        stopReason = "error";
        break;
      }
      if (promptTooLongMessage !== null) {
        if (!promptTooLongRetried) {
          // issue #261 — the estimator undercounted (system prompt +
          // tool catalogue aren't in the history estimate, and chars/4
          // is rough). Compact HARDER than pre-flight: target half of
          // the current estimate — guaranteed shrink regardless of
          // estimator error — capped at half the ceiling the provider
          // reported, so small-window models get a fitting target too.
          promptTooLongRetried = true;
          const reportedLimit = parsePromptTooLongLimit(promptTooLongMessage);
          const retryTarget = Math.floor(
            Math.min(
              estimateHistoryTokens(messages) / 2,
              reportedLimit !== null ? reportedLimit / 2 : Number.POSITIVE_INFINITY,
            ),
          );
          const compacted = compactHistory(messages, {
            targetTokens: retryTarget,
            keepRecentMessages: KEEP_RECENT_MESSAGES,
            toolResultHeadChars: RETRY_TOOL_RESULT_HEAD_CHARS,
          });
          messages = compacted.messages;
          console.error("[chat-runner] prompt-too-long-retry", {
            chatSessionId,
            loop,
            providerMessage: promptTooLongMessage,
            retryTarget,
            estimatedTokensBefore: compacted.estimatedTokensBefore,
            estimatedTokensAfter: compacted.estimatedTokensAfter,
            toolResultsTruncated: compacted.toolResultsTruncated,
            summarizedMessages: compacted.summarizedMessages,
          });
          // The retry replaces the failed call — don't burn a loop slot
          // on a turn the model never produced.
          loop--;
          continue;
        }
        // Retry already spent and the provider still rejects: tell the
        // operator what happened + what to do, in the transcript, so
        // the session isn't run #7's silent dead end.
        const notice =
          "This conversation exceeded the AI model's context limit. I compacted the older " +
          "history and retried, but the request still did not fit. The session history has " +
          "been compacted — please send your message again; if it still fails, start a new " +
          "chat for the next task.";
        console.error("[chat-runner] prompt-too-long-unrecovered", {
          chatSessionId,
          loop,
          providerMessage: promptTooLongMessage,
        });
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
        yield { kind: "error", message: notice };
      }
      succeeded = false;
      stopReason = "error";
      break;
    }

    const assistantContent = accumulatedText.join("");

    // Run #8 R1 — empty content at EXACTLY the output-token cap. Adaptive
    // thinking shares max_tokens with the visible output; on hard turns it
    // can consume the entire budget, so the model stops at `max_tokens`
    // having produced zero text and zero tool calls. Pre-run-#8 this
    // persisted a silent empty assistant message and the session drifted
    // on. Retry ONCE with a doubled ceiling (re-running at the same
    // ceiling would likely fail identically); if the retry also comes
    // back empty, persist a VISIBLE error notice — no silent empties
    // (CLAUDE.md §2 no-fallbacks).
    if (
      loopStop === "max_tokens" &&
      assistantContent.length === 0 &&
      accumulatedToolCalls.length === 0 &&
      !aborted()
    ) {
      if (!emptyAtCapRetried) {
        emptyAtCapRetried = true;
        maxOutputTokensThisTurn = Math.min(maxOutputTokensThisTurn * 2, 65536);
        console.error("[chat-runner] empty-at-output-cap-retry", {
          chatSessionId,
          loop,
          previousMaxOutputTokens: args.maxOutputTokens,
          retryMaxOutputTokens: maxOutputTokensThisTurn,
          rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
        });
        // The retry replaces the failed call — don't burn a loop slot on
        // a turn that produced nothing.
        loop--;
        continue;
      }
      const notice =
        "The AI's response was cut off at its output limit before any visible content was " +
        "produced (internal reasoning consumed the whole budget). I retried once with a larger " +
        "budget and it happened again — please send your message again, or split the request " +
        "into smaller steps.";
      console.error("[chat-runner] empty-at-output-cap-unrecovered", {
        chatSessionId,
        loop,
        maxOutputTokens: maxOutputTokensThisTurn,
        rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
      });
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
      yield { kind: "error", message: notice };
      stopReason = "error";
      succeeded = false;
      break;
    }

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
    if (accumulatedToolCalls.length === 0) {
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
    // Run #8 live-edit CI — image follow-ups collect here and append
    // AFTER the loop, so every tool result of the turn precedes the
    // first user (image) message (see dispatchToolCall's parameter doc).
    //
    // Pairing invariant — dispatch EVERY accumulated tool call, whatever
    // the stop_reason. The tool_use blocks that reached `accumulatedToolCalls`
    // are complete (the stream parser only emits a tool-call on
    // content_block_stop), so a non-`tool_use` stop (`max_tokens` when
    // adaptive thinking burned the output budget right after emitting the
    // tool_use, or a stray `end_turn`) does NOT mean the call was partial —
    // it means the model stopped generating AFTER committing to the call.
    // Pre-fix this branch was gated on `loopStop === "tool_use"`, so a
    // `max_tokens` stop skipped dispatch entirely: the assistant tool_use
    // was persisted but no tool_result was, leaving a dangling pair that
    // Anthropic 400s on every subsequent turn ("tool results are missing for
    // tool calls …") — a permanent, reload-proof brick (the offer_choices
    // free-text-answer wedge). Dispatching here keeps the persisted
    // transcript pairing-complete so a free-text OR click answer next turn
    // replays a valid history.
    const deferredImageMessages: ChatMessageInput[] = [];
    for (const call of accumulatedToolCalls) {
      if (aborted()) break;
      yield* dispatchToolCall(
        call,
        messages,
        {
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
        },
        deferredImageMessages,
      );
    }
    messages.push(...deferredImageMessages);

    // Only loop again when the model actually signalled it wants to keep
    // going with a `tool_use` stop. Any other stop_reason ends the turn now
    // that the pairing is complete — the tool results ARE persisted, and the
    // cap-exhaustion notice below fires only on a trailing `tool_use` stop.
    if (loopStop !== "tool_use") {
      stopReason = loopStop;
      break;
    }
  }

  // v0.3.20 — cap-exhaustion notice. If the for-loop ran to completion AND
  // the last iteration ended with the AI still wanting to call more tools,
  // we hit `maxLoops`. Surface a clear user-visible message.
  // Run #8 live-edit CI — also require `succeeded`: a provider error that
  // breaks the loop mid-run leaves lastLoopStop at the PREVIOUS
  // iteration's "tool_use"; pre-fix, this block then mislabelled the
  // failure as a cap hit ("reply continue to resume") on top of the
  // real error event.
  if (lastLoopStop === "tool_use" && !aborted() && succeeded) {
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
