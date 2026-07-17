// SPDX-License-Identifier: MPL-2.0

/**
 * Provider-stream consumption for one tool-loop iteration. Extracted verbatim
 * from the pre-split `chat-runner.ts`: drives `provider.generate(...)`, relays
 * text / thinking deltas as `ClientEvent`s, accumulates text / tool-calls /
 * thinking, tracks usage into a shared accumulator, applies the P10.5 soft
 * cost cap, and captures the v0.10.17 stop diagnostics.
 *
 * Yielded as `yield*` from the loop in `index.ts`; the `return` value carries
 * the per-iteration accumulators back to the orchestrator.
 */

import type { AIProvider, ChatMessageInput, ProviderEvent } from "../provider.js";
import { isPromptTooLongError } from "./compaction.js";
import { costCapUsd, microcents, resolveFirstEventTimeoutMs } from "./limits.js";
import type { FilteredTool } from "./tool-catalogue.js";
import type {
  AccumulatedServerToolCall,
  AccumulatedToolCall,
  ApprovalRequest,
  ClientEvent,
  StoppingDiagnostics,
} from "./types.js";

/** Running usage totals mutated in place across the turn's loop iterations. */
export interface UsageAccumulator {
  totalIn: number;
  totalOut: number;
  totalCached: number;
}

export interface StreamTurnResult {
  accumulatedText: string[];
  accumulatedToolCalls: AccumulatedToolCall[];
  /** Provider-executed (Tool Search) calls — recorded, never dispatched. */
  accumulatedServerToolCalls: AccumulatedServerToolCall[];
  /**
   * Slice 1 (SDK approval gate) — gated tool calls the SDK PAUSED before
   * executing, awaiting a human tool-approval-response. The loop surfaces
   * these to the operator (in-chat Approve/Reject), does NOT dispatch the
   * matching tool-calls, and stops the turn. Empty on a normal turn.
   */
  accumulatedApprovalRequests: ApprovalRequest[];
  accumulatedThinking: { thinking: string; signature: string }[];
  /**
   * Option C (2026-07) — the SDK's canonical ModelMessage assembly for
   * this provider call (`turn-messages` event). Persisted per assistant
   * turn and replayed verbatim as history (CLAUDE.md §12). Empty when the
   * turn errored/aborted before the response resolved.
   */
  accumulatedTurnMessages: unknown[];
  loopStop: "end_turn" | "tool_use" | "max_tokens" | "error" | "max_loops" | "session_gone";
  providerErr: boolean;
  /**
   * issue #261 — set (with the raw provider message) when the provider
   * rejected the call for exceeding its context window. The raw error
   * is NOT yielded to the client in that case; loop.ts owns recovery
   * (compact harder + retry once) and the operator-facing messaging.
   */
  promptTooLongMessage: string | null;
  /**
   * Run #10 D5 — true when the provider call produced ZERO stream
   * events within the first-event watchdog window and was aborted.
   * Like promptTooLongMessage, nothing is yielded to the client here;
   * loop.ts owns recovery (retry once) and the operator messaging.
   */
  firstEventTimedOut: boolean;
  stoppingDiagnostics: StoppingDiagnostics | null;
}

export async function* streamProviderTurn(args: {
  provider: AIProvider;
  systemPrompt: Parameters<AIProvider["generate"]>[0]["systemPrompt"];
  messages: ChatMessageInput[];
  tools: FilteredTool[];
  abortSignal: AbortSignal | undefined;
  maxTokens: number;
  temperature: number | undefined;
  thinkingBudget: number | null;
  usage: UsageAccumulator;
  costCapMicrocents: number | undefined;
  inputCost: number;
  outputCost: number;
  /**
   * Run #10 D5 — first-event watchdog window override (tests). Absent
   * ⇒ `resolveFirstEventTimeoutMs()` (env-tunable, 180s default).
   */
  firstEventTimeoutMs?: number;
}): AsyncGenerator<ClientEvent, StreamTurnResult> {
  const { provider, messages, tools, abortSignal, usage } = args;
  const aborted = (): boolean => abortSignal?.aborted === true;

  const accumulatedText: string[] = [];
  const accumulatedToolCalls: AccumulatedToolCall[] = [];
  const accumulatedServerToolCalls: AccumulatedServerToolCall[] = [];
  // Slice 1 (SDK approval gate) — gated tool calls the SDK paused.
  const accumulatedApprovalRequests: ApprovalRequest[] = [];
  // v0.2.54 — accumulate thinking blocks emitted on this turn for
  // persistence + round-trip on the next loop's provider call.
  const accumulatedThinking: { thinking: string; signature: string }[] = [];
  // Option C — the SDK's canonical messages for this provider call.
  let accumulatedTurnMessages: unknown[] = [];
  let loopStop: StreamTurnResult["loopStop"] = "end_turn";
  let providerErr = false;
  let promptTooLongMessage: string | null = null;
  let firstEventTimedOut = false;
  // v0.10.17 — populated by the `done` event when the underlying
  // adapter forwards provider stop metadata. Read by the empty-
  // response detector below to log Anthropic's raw stop_reason etc.
  let stoppingDiagnostics: StoppingDiagnostics | null = null;

  // Run #10 D5 — first-event watchdog plumbing. The provider gets a
  // DERIVED abort signal so the watchdog can cancel a hung HTTP
  // request without touching the operator's request signal; the
  // manual-iterator loop below races only the FIRST `next()` against
  // the timer (once the stream is demonstrably alive, in-stream idle
  // gaps are the SSE keep-alive's problem, not ours).
  const firstEventTimeoutMs = args.firstEventTimeoutMs ?? resolveFirstEventTimeoutMs();
  const watchdogCtrl = new AbortController();
  const onOuterAbort = (): void => watchdogCtrl.abort();
  if (abortSignal?.aborted) watchdogCtrl.abort();
  else abortSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const callStartedAt = Date.now();

  const stream = provider
    .generate({
      systemPrompt: args.systemPrompt,
      messages,
      tools,
      abortSignal: watchdogCtrl.signal,
      maxTokens: args.maxTokens,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      ...(args.thinkingBudget !== null ? { thinking: { budgetTokens: args.thinkingBudget } } : {}),
    })
    [Symbol.asyncIterator]();

  try {
    let sawFirstEvent = false;
    while (true) {
      let step: IteratorResult<ProviderEvent>;
      if (!sawFirstEvent) {
        // Race only the FIRST next() against the watchdog. Once the
        // stream is demonstrably alive, mid-stream pacing is normal
        // (thinking pauses, tool_use assembly) and stays untimed.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"first-event-timeout">((resolve) => {
          timer = setTimeout(() => resolve("first-event-timeout"), firstEventTimeoutMs);
        });
        const firstNext = stream.next();
        const raced = await Promise.race([firstNext, timeout]);
        clearTimeout(timer);
        if (raced === "first-event-timeout") {
          firstEventTimedOut = true;
          providerErr = true;
          // Cancel the hung HTTP request; the operator's own signal is
          // untouched, so the loop-level retry reuses it cleanly. The
          // orphaned next() settles with the abort — swallow it so it
          // can't surface as an unhandled rejection.
          void firstNext.catch(() => {});
          watchdogCtrl.abort();
          console.error("[chat-runner] provider-first-event-timeout", {
            firstEventTimeoutMs,
            messageCount: messages.length,
          });
          break;
        }
        step = raced;
        sawFirstEvent = true;
        // Run #10 D5 — time-to-first-event telemetry on EVERY call so a
        // silent-start regression is measurable from logs alone.
        console.error("[chat-runner] provider-first-event", {
          msToFirstEvent: Date.now() - callStartedAt,
          messageCount: messages.length,
        });
      } else {
        step = await stream.next();
      }
      if (step.done) break;
      const ev = step.value;
      if (aborted()) break;
      if (ev.kind === "text-delta") {
        accumulatedText.push(ev.text);
        yield { kind: "text-delta", text: ev.text };
      } else if (ev.kind === "thinking-delta") {
        // Stream-through: client renders progressively in the
        // collapsed thinking block. Final text is captured at
        // thinking-stop; mid-stream we don't accumulate here to avoid
        // double-buffering.
        yield { kind: "thinking-delta", text: ev.text };
      } else if (ev.kind === "thinking-stop") {
        // Sonnet 5's adaptive thinking sometimes closes a reasoning block
        // with EMPTY text. Persisting it poisons the session: the replay
        // on the next turn 400s with "each thinking block must contain
        // thinking" and the whole chat dies. Empty blocks carry no signed
        // content worth replaying — drop them at the source.
        if (ev.thinking.length > 0) {
          accumulatedThinking.push({ thinking: ev.thinking, signature: ev.signature });
        }
        yield { kind: "thinking-stop", thinking: ev.thinking, signature: ev.signature };
      } else if (ev.kind === "tool-call") {
        accumulatedToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.kind === "server-tool-call") {
        accumulatedServerToolCalls.push({
          id: ev.id,
          name: ev.name,
          arguments: ev.arguments,
          serverExecuted: true,
        });
      } else if (ev.kind === "server-tool-result") {
        // Attach to its call; an orphan result (call not seen — cut
        // stream) is dropped rather than persisted unpaired.
        const call = accumulatedServerToolCalls.find((c) => c.id === ev.id);
        if (call) call.result = ev.result;
      } else if (ev.kind === "tool-approval-request") {
        // Slice 1 — a gated tool paused before execute. Record it so the
        // loop surfaces the in-chat Approve/Reject and skips dispatching the
        // paired tool-call (the SDK owns that execute once approved).
        accumulatedApprovalRequests.push({
          approvalId: ev.approvalId,
          toolCallId: ev.toolCallId,
          name: ev.name,
          arguments: ev.arguments,
        });
      } else if (ev.kind === "turn-messages") {
        // Option C — the SDK's canonical assembly for THIS provider call
        // (streamProviderTurn drives exactly one). The loop persists it as
        // this assistant turn's replay history.
        accumulatedTurnMessages = [...ev.messages];
      } else if (ev.kind === "usage") {
        usage.totalIn += ev.inputTokens;
        usage.totalOut += ev.outputTokens;
        usage.totalCached += ev.cachedTokens;
        // P10.5 #3 — soft cost cap. spawn_subagent passes the spec's
        // maxCostMicrocents through; runner aborts before the next
        // provider call instead of letting the budget overrun.
        if (args.costCapMicrocents !== undefined) {
          const usdSoFar = costCapUsd(
            usage.totalIn,
            usage.totalCached,
            usage.totalOut,
            args.inputCost,
            args.outputCost,
          );
          if (microcents(usdSoFar) > args.costCapMicrocents) {
            providerErr = true;
            yield {
              kind: "error",
              message: `cost cap reached: spent ~${microcents(usdSoFar)} µ¢ / cap ${args.costCapMicrocents} µ¢`,
            };
          }
        }
      } else if (ev.kind === "done") {
        loopStop = ev.stopReason;
        // v0.10.17 — stash provider diagnostics so the empty-response
        // detector below can include them in stderr. These are the
        // ONLY fields that explain why the model returned empty
        // (Anthropic's stop_reason, SDK warnings, finishReason).
        if (ev.stoppingDiagnostics) {
          stoppingDiagnostics = ev.stoppingDiagnostics;
        }
      } else if (ev.kind === "error") {
        providerErr = true;
        if (isPromptTooLongError(ev.message)) {
          // issue #261 — swallow the raw context-overflow error; loop.ts
          // compacts + retries, and only surfaces a message if that fails.
          promptTooLongMessage = ev.message;
        } else {
          yield { kind: "error", message: ev.message };
        }
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onOuterAbort);
  }

  return {
    accumulatedText,
    accumulatedToolCalls,
    accumulatedServerToolCalls,
    accumulatedApprovalRequests,
    accumulatedThinking,
    accumulatedTurnMessages,
    loopStop,
    providerErr,
    promptTooLongMessage,
    firstEventTimedOut,
    stoppingDiagnostics,
  };
}
