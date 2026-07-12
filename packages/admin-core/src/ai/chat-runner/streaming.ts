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

import type { AIProvider, ChatMessageInput } from "../provider.js";
import { isPromptTooLongError } from "./compaction.js";
import { costCapUsd, microcents } from "./limits.js";
import type { FilteredTool } from "./tool-catalogue.js";
import type { AccumulatedToolCall, ClientEvent, StoppingDiagnostics } from "./types.js";

/** Running usage totals mutated in place across the turn's loop iterations. */
export interface UsageAccumulator {
  totalIn: number;
  totalOut: number;
  totalCached: number;
}

export interface StreamTurnResult {
  accumulatedText: string[];
  accumulatedToolCalls: AccumulatedToolCall[];
  accumulatedThinking: { thinking: string; signature: string }[];
  loopStop: "end_turn" | "tool_use" | "max_tokens" | "error" | "max_loops" | "session_gone";
  providerErr: boolean;
  /**
   * issue #261 — set (with the raw provider message) when the provider
   * rejected the call for exceeding its context window. The raw error
   * is NOT yielded to the client in that case; loop.ts owns recovery
   * (compact harder + retry once) and the operator-facing messaging.
   */
  promptTooLongMessage: string | null;
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
}): AsyncGenerator<ClientEvent, StreamTurnResult> {
  const { provider, messages, tools, abortSignal, usage } = args;
  const aborted = (): boolean => abortSignal?.aborted === true;

  const accumulatedText: string[] = [];
  const accumulatedToolCalls: AccumulatedToolCall[] = [];
  // v0.2.54 — accumulate thinking blocks emitted on this turn for
  // persistence + round-trip on the next loop's provider call.
  const accumulatedThinking: { thinking: string; signature: string }[] = [];
  let loopStop: StreamTurnResult["loopStop"] = "end_turn";
  let providerErr = false;
  let promptTooLongMessage: string | null = null;
  // v0.10.17 — populated by the `done` event when the underlying
  // adapter forwards provider stop metadata. Read by the empty-
  // response detector below to log Anthropic's raw stop_reason etc.
  let stoppingDiagnostics: StoppingDiagnostics | null = null;

  for await (const ev of provider.generate({
    systemPrompt: args.systemPrompt,
    messages,
    tools,
    abortSignal,
    maxTokens: args.maxTokens,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.thinkingBudget !== null ? { thinking: { budgetTokens: args.thinkingBudget } } : {}),
  })) {
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
      accumulatedThinking.push({ thinking: ev.thinking, signature: ev.signature });
      yield { kind: "thinking-stop", thinking: ev.thinking, signature: ev.signature };
    } else if (ev.kind === "tool-call") {
      accumulatedToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
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

  return {
    accumulatedText,
    accumulatedToolCalls,
    accumulatedThinking,
    loopStop,
    providerErr,
    promptTooLongMessage,
    stoppingDiagnostics,
  };
}
