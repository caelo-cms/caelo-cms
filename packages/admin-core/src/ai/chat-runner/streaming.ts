// SPDX-License-Identifier: MPL-2.0

/**
 * issue #442 — one SDK-loop RUN for the chat-runner. `streamProviderTurn`
 * drives a single `provider.generate` call whose inside is the AI SDK's own
 * multi-step tool loop (streamText + stopWhen/prepareStep/onStepFinish —
 * CLAUDE.md §12): the SDK executes our tools through per-tool `execute`
 * wrappers, consumes provider-deferred tool results (the Anthropic
 * tool-search continuation that permanently wedged session 57c2f0f5 under
 * the old one-call-per-iteration loop), and this module re-homes the
 * between-call concerns that used to live between iterations:
 *
 *  - per-step ASSISTANT persistence with the crash-safety anchor: the first
 *    execute wrapper of a step persists the assistant row BEFORE any tool
 *    effect lands (the SDK only starts client-tool execution after the
 *    model's step output is complete, so the accumulators are final);
 *  - per-step Option-C persistence: `onStepFinish` stamps the SDK's own
 *    per-step `response.messages` slice onto the anchor row — the same
 *    passthrough replay shape the pre-#442 per-iteration rows had;
 *  - ordered SSE eventing through one EventQueue (provider events via the
 *    pump, tool events via the wrappers) — see event-queue.ts;
 *  - sequential dispatch: a serial gate runs wrapper dispatches one at a
 *    time in tool-call order, preserving the pre-#442 sequential semantics
 *    (two write tools in one turn must not interleave their transactions).
 *
 * Loop POLICY (budget gate, runaway guard, compaction, retries, notices)
 * stays in loop.ts and reaches the SDK through the `policy` callbacks.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import type {
  AIProvider,
  ChatMessageInput,
  ProviderEvent,
  ProviderResponseMessage,
  ProviderStepSummary,
} from "../provider.js";
import type { ToolRegistry } from "../tools/index.js";
import { estimateTextTokens, isPromptTooLongError } from "./compaction.js";
import { buildContextSplitEstimate } from "./context-split.js";
import { EventQueue, PumpQuiescence } from "./event-queue.js";
import { appendLoopTrace, fingerprintMessages, hashOf, loopTracePath } from "./loop-trace.js";
import { resolveFirstEventTimeoutMs } from "./limits.js";
import { persistAssistantTurn, setResponseMessages } from "./persistence.js";
import type { ToolResultOrigin } from "./proactive-compaction.js";
import {
  blockedCallResult,
  type RepeatedFailureTracker,
  repeatedFailureNudge,
} from "./repeat-failure-guard.js";
import type { FilteredTool } from "./tool-catalogue.js";
import { dispatchToolCall, type ToolCallOutcome } from "./tool-dispatch.js";
import type {
  AccumulatedServerToolCall,
  AccumulatedToolCall,
  ApprovalRequest,
  ChatRunnerOptions,
  ClientEvent,
  RunChatTurnFn,
  StoppingDiagnostics,
} from "./types.js";
import { isWriteTool } from "./write-tools.js";

/** Running usage totals mutated in place across the turn's runs + steps. */
export interface UsageAccumulator {
  totalIn: number;
  totalOut: number;
  totalCached: number;
  /** Cumulative Anthropic cache WRITE tokens (cache_creation) this turn. */
  totalCacheCreation?: number;
}

/**
 * The between-step policy loop.ts owns. Both hooks run INSIDE the SDK's
 * step machinery (the SDK awaits them), strictly ordered after the step's
 * persistence (`onStepFinish` in this module runs first).
 *
 * `prepareStep` is invoked for CONTINUATION steps only (stepIndex ≥ 1) —
 * the run prologue in loop.ts owns the first call's injections, because the
 * initial messages are converted before step 0's prepareStep could mutate
 * them. Mutating the shared history inside the hook is the way to inject:
 * this module always overrides continuation-step messages with the current
 * history (byte-identical to a fresh cross-turn call — cache parity).
 */
export interface RunPolicy {
  prepareStep(info: {
    stepIndex: number;
    steps: readonly ProviderStepSummary[];
  }): Promise<void>;
  stopWhen(info: { steps: readonly ProviderStepSummary[] }): Promise<boolean> | boolean;
}

export interface StreamTurnResult {
  /** Final stop of the run (the SDK's last step's mapped finish reason). */
  loopStop: "end_turn" | "tool_use" | "max_tokens" | "error" | "max_loops" | "session_gone";
  providerErr: boolean;
  /**
   * issue #261 — set (with the raw provider message) when the provider
   * rejected a step for exceeding its context window. Not surfaced to the
   * client here; loop.ts owns recovery (compact harder + retry once).
   */
  promptTooLongMessage: string | null;
  /**
   * issue #442 — the SDK's native first-chunk watchdog aborted the run (no
   * stream data inside the window). loop.ts owns the one-shot retry.
   */
  firstEventTimedOut: boolean;
  /** Raw message of a turn-fatal provider error surfaced to the client. */
  providerErrorMessage: string | null;
  stoppingDiagnostics: StoppingDiagnostics | null;
  /** Gated calls paused on tool-approval-requests, across all steps. */
  approvalRequests: ApprovalRequest[];
  /** Steps this run completed (finalized through onStepFinish). */
  stepsCount: number;
  /** Final finalized step's visible text (RECOVER / empty-at-cap checks). */
  finalStepText: string;
  /** Final finalized step's client tool-call count. */
  finalStepClientToolCalls: number;
  /** Final finalized step's thinking blocks (loop-0 diagnostics input). */
  finalStepThinking: { thinking: string; signature: string }[];
  lastAssistantMessageId: string | null;
  /** PR #61 — session row vanished mid-run (benign race); stop quietly. */
  sessionGone: boolean;
  /** Non-session-gone assistant persist failure (fail loud upstream). */
  persistFailureMessage: string | null;
  /**
   * A step the run started but never finalized (abort / provider error
   * mid-step). `anchorMessageId` is non-null when the step's assistant row
   * was already persisted by the anchor gate — loop.ts must not persist a
   * second row for it.
   */
  pendingStep: {
    text: string;
    thinking: { thinking: string; signature: string }[];
    serverToolCalls: AccumulatedServerToolCall[];
    clientToolCalls: AccumulatedToolCall[];
    anchorMessageId: string | null;
  } | null;
}

export interface StreamTurnArgs {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
  humanCtx: ExecutionContext;
  aiCtxWithBranch: ExecutionContext;
  provider: AIProvider;
  tools: ToolRegistry;
  options: ChatRunnerOptions;
  runChatTurn: RunChatTurnFn;
  chatSessionId: string;
  chatBranchId: string;
  abortSignal: AbortSignal | undefined;
  systemPrompt: Parameters<AIProvider["generate"]>[0]["systemPrompt"];
  /**
   * The turn's shared in-memory provider history. This module APPENDS the
   * run's rows (per-step assistant entry + tool rows + deferred image
   * messages + breaker nudges); loop.ts may REPLACE `messages` wholesale
   * (compaction) — hence the box.
   */
  history: { messages: ChatMessageInput[] };
  filteredTools: FilteredTool[];
  policy: RunPolicy;
  /**
   * issue #106 RECOVER — force `toolChoice:"required"` on THIS run's first
   * step only (the SDK's top-level toolChoice would force every step).
   */
  forceToolChoiceFirstStep: boolean;
  /**
   * Monotonic step counter across the turn's runs (retries continue the
   * numbering) — keys the proactive-compaction origins map and the per-step
   * trace, replacing the old per-iteration `loop` index.
   */
  stepCounter: { value: number };
  maxTokens: number;
  temperature: number | undefined;
  thinkingBudget: number | null;
  usage: UsageAccumulator;
  firstEventTimeoutMs?: number;
  failureTracker: RepeatedFailureTracker;
  toolResultOrigins: Map<string, ToolResultOrigin>;
  /** Turn-level tool-name log (judge input) — appended per step. */
  turnToolNames: string[];
  /** Turn-level DETECT state (issue #106) — flipped on the first write. */
  turnState: { hasWritten: boolean };
}

/** Per-step accumulation while the SDK streams + executes that step. */
interface StepState {
  /** Global (turn-scoped) step number — see StreamTurnArgs.stepCounter. */
  index: number;
  text: string[];
  thinking: { thinking: string; signature: string }[];
  clientCalls: AccumulatedToolCall[];
  serverCalls: AccumulatedServerToolCall[];
  /** ids this run's wrappers produced a result for (incl. blocked/aborted). */
  executedIds: Set<string>;
  toolRows: ChatMessageInput[];
  deferredImages: ChatMessageInput[];
  outcomes: ToolCallOutcome[];
  anchorMessageId: string | null;
  anchorPromise: Promise<void> | null;
  usageBefore: { in: number; cached: number; creation: number; out: number };
  finalized: boolean;
}

/**
 * Drop the step's OWN client-tool-result message from the SDK's per-step
 * slice. Our wrappers persist every client tool result as a role='tool'
 * chat_messages row (dedup cache, UI transcript), and the replay
 * reconstructs those rows into tool-result messages — keeping the slice's
 * copy too would double every result on replay. Everything else in the
 * slice (reasoning + signatures, text, client AND providerExecuted
 * tool-calls, providerExecuted tool-results, approval-request parts) stays
 * verbatim — that is exactly the pre-#442 per-iteration Option-C shape,
 * proven in production replay.
 */
function stripOwnClientToolResults(
  slice: readonly ProviderResponseMessage[],
  executedIds: ReadonlySet<string>,
): ProviderResponseMessage[] {
  return slice.filter((msg) => {
    if (msg === null || typeof msg !== "object") return true;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== "tool" || !Array.isArray(m.content)) return true;
    const allOwn = m.content.every((part) => {
      if (part === null || typeof part !== "object") return false;
      const p = part as { type?: unknown; toolCallId?: unknown };
      return (
        p.type === "tool-result" &&
        typeof p.toolCallId === "string" &&
        executedIds.has(p.toolCallId)
      );
    });
    if (!allOwn && m.content.length > 0) {
      // A tool message mixing our results with something else would be a new
      // SDK shape — keep it verbatim but say so loudly (§2 no-fallbacks:
      // never silently drop content we don't understand).
      console.error("[chat-runner] step slice tool message kept — unrecognized mix", {
        parts: m.content.length,
      });
    }
    return !allOwn;
  });
}

export async function* streamProviderTurn(
  args: StreamTurnArgs,
): AsyncGenerator<ClientEvent, StreamTurnResult> {
  const { registry, adapter, humanCtx, provider, history, policy } = args;
  const aborted = (): boolean => args.abortSignal?.aborted === true;

  const queue = new EventQueue<ClientEvent>();
  const quiescence = new PumpQuiescence();

  const result: StreamTurnResult = {
    loopStop: "end_turn",
    providerErr: false,
    promptTooLongMessage: null,
    firstEventTimedOut: false,
    providerErrorMessage: null,
    stoppingDiagnostics: null,
    approvalRequests: [],
    stepsCount: 0,
    finalStepText: "",
    finalStepClientToolCalls: 0,
    finalStepThinking: [],
    lastAssistantMessageId: null,
    sessionGone: false,
    persistFailureMessage: null,
    pendingStep: null,
  };

  let step: StepState | null = null;
  // Turn-level registry of server (tool-search) calls so a DEFERRED result —
  // delivered by the API in a LATER step than its call (the #442 wire
  // behavior) — still attaches to its call for the persisted tool_calls
  // jsonb (audit/UI). Pairing correctness itself rides the per-step slices.
  const serverCallsById = new Map<string, AccumulatedServerToolCall>();
  // issue #442 — serial dispatch gate: the SDK fires tool executes in
  // parallel (Promise.all); chaining them here preserves the pre-#442
  // strictly-sequential dispatch order (snapshot/tx interleaving safety).
  let serialDispatch: Promise<void> = Promise.resolve();

  const callStartedAt = Date.now();
  let sawFirstEvent = false;

  const beginStep = (): void => {
    args.stepCounter.value += 1;
    step = {
      index: args.stepCounter.value,
      text: [],
      thinking: [],
      clientCalls: [],
      serverCalls: [],
      executedIds: new Set(),
      toolRows: [],
      deferredImages: [],
      outcomes: [],
      anchorMessageId: null,
      anchorPromise: null,
      usageBefore: {
        in: args.usage.totalIn,
        cached: args.usage.totalCached,
        creation: args.usage.totalCacheCreation ?? 0,
        out: args.usage.totalOut,
      },
      finalized: false,
    };
  };

  /**
   * Crash-safety anchor (issue #442 G4): persist the step's assistant row
   * BEFORE the first tool effect. Sound because the SDK defers client-tool
   * execution to the model call's end — by the time any wrapper runs, every
   * model-output part of the step is already enqueued, and the quiescence
   * latch guarantees the pump accumulated them all.
   */
  const ensureAnchor = (s: StepState): Promise<void> => {
    if (s.anchorPromise) return s.anchorPromise;
    s.anchorPromise = (async () => {
      await quiescence.whenQuiescent();
      const saved = await persistAssistantTurn(registry, adapter, humanCtx, {
        chatSessionId: args.chatSessionId,
        content: s.text.join(""),
        toolCalls: [...s.serverCalls, ...s.clientCalls],
        thinkingBlocks: s.thinking.length > 0 ? s.thinking : null,
        // The SDK's per-step slice does not exist yet (it is assembled after
        // the step's tool executions settle); onStepFinish stamps it via
        // chat.set_response_messages. A crash in between leaves this row on
        // the reconstruction lane — the same fallback errored turns use.
        responseMessages: null,
        status: "complete",
      });
      if (saved.ok) {
        s.anchorMessageId = saved.messageId;
        result.lastAssistantMessageId = saved.messageId;
        queue.push({ kind: "assistant-message-saved", messageId: saved.messageId });
        return;
      }
      if (saved.sessionGone) {
        console.warn("[chat-runner] session gone mid-run; terminating quietly", {
          chatSessionId: args.chatSessionId,
        });
        result.sessionGone = true;
        return;
      }
      console.error("[chat-runner] failed to persist assistant message", {
        chatSessionId: args.chatSessionId,
        error: saved.message,
      });
      queue.push({ kind: "error", message: `Failed to save assistant message: ${saved.message}` });
      result.persistFailureMessage = saved.message;
    })();
    return s.anchorPromise;
  };

  const fatalPersist = (): boolean => result.sessionGone || result.persistFailureMessage !== null;

  /** One wrapped dispatch — runs under the serial gate, after the anchor. */
  const runWrappedDispatch = async (
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): Promise<string> => {
    const s = step;
    if (!s) {
      // §2 fail loud — an execute outside any step means our understanding
      // of the SDK's sequencing broke; do NOT touch the site on a guess.
      throw new Error(
        `[chat-runner] tool execute for ${toolName} arrived outside a step — dispatch refused`,
      );
    }
    await ensureAnchor(s);
    s.executedIds.add(toolCallId);
    if (fatalPersist()) {
      // No dispatch without a persisted anchor: effects must never land
      // without a transcript trace. The run is stopping (stopWhen).
      return "Tool call skipped: the assistant turn could not be persisted.";
    }
    if (aborted()) {
      // Theme B, inverted for the SDK loop: instead of dropping the
      // unanswered tool_use from the persisted row, answer it with a
      // synthetic failed result so the pairing stays complete.
      const content = "Tool call not executed: the operator interrupted the turn.";
      queue.push({ kind: "tool-start", toolCallId, name: toolName, arguments: input });
      queue.push({ kind: "tool-result", toolCallId, ok: false, content });
      await execute(registry, adapter, humanCtx, "chat.append_message", {
        chatSessionId: args.chatSessionId,
        role: "tool",
        content,
        toolCallId,
        source: `tool result (${toolName})`,
      });
      s.toolRows.push({ role: "tool", content, toolCallId });
      args.toolResultOrigins.set(toolCallId, { loop: s.index, ok: false });
      return content;
    }
    // Breaker: an identical (tool + args) call already failed identically
    // twice this turn. Don't re-run it — reply with a synthetic failed
    // result so the tool_use/tool_result pairing stays complete without
    // spending another dispatch on a call known to fail the same way.
    if (args.failureTracker.isBlocked(toolName, input)) {
      const content = blockedCallResult(toolName);
      queue.push({ kind: "tool-start", toolCallId, name: toolName, arguments: input });
      queue.push({ kind: "tool-result", toolCallId, ok: false, content });
      await execute(registry, adapter, humanCtx, "chat.append_message", {
        chatSessionId: args.chatSessionId,
        role: "tool",
        content,
        toolCallId,
        source: `tool result (${toolName})`,
      });
      s.toolRows.push({ role: "tool", content, toolCallId });
      args.toolResultOrigins.set(toolCallId, { loop: s.index, ok: false });
      return content;
    }
    await dispatchToolCall(
      { id: toolCallId, name: toolName, arguments: input },
      {
        registry,
        adapter,
        humanCtx,
        aiCtxWithBranch: args.aiCtxWithBranch,
        provider,
        tools: args.tools,
        chatSessionId: args.chatSessionId,
        chatBranchId: args.chatBranchId,
        options: args.options,
        runChatTurn: args.runChatTurn,
      },
      {
        emit: (event) => queue.push(event),
        stepToolRows: s.toolRows,
        deferredImageMessages: s.deferredImages,
        outcomes: s.outcomes,
      },
    );
    for (let i = s.outcomes.length - 1; i >= 0; i--) {
      const o = s.outcomes[i];
      if (o && o.toolCallId === toolCallId) return o.content;
    }
    return "";
  };

  /**
   * Attach the dispatch wrapper to every routine tool. Gated tools keep
   * their pre-set execute (the Owner-scope propose→execute_proposal chain):
   * it runs SDK-side behind the approval pause — and on a resume turn BEFORE
   * step 0 exists — so the step-scoped anchor/serial machinery deliberately
   * does not apply to it (matches the pre-#442 behavior, where gated
   * executes also ran outside the dispatch loop).
   */
  const wrappedTools: FilteredTool[] = args.filteredTools.map((t) => {
    if (t.execute) return t;
    return {
      ...t,
      execute: async (input: unknown, opts?: { toolCallId?: string }): Promise<unknown> => {
        const toolCallId = opts?.toolCallId;
        if (!toolCallId) {
          // §2 fail loud — without the SDK's tool_use id we cannot persist a
          // paired tool row; a made-up id would poison the replay.
          throw new Error(
            `[chat-runner] SDK execute for ${t.name} carried no toolCallId — dispatch refused`,
          );
        }
        const run = serialDispatch.then(() => runWrappedDispatch(toolCallId, t.name, input));
        serialDispatch = run.then(
          () => undefined,
          () => undefined,
        );
        return await run;
      },
    };
  });

  /** Per-step persistence + history append — the SDK awaits this. */
  const onStepFinish = async (info: {
    stepIndex: number;
    finishReason: string;
    responseMessages: readonly ProviderResponseMessage[];
    initialResponseMessages: readonly ProviderResponseMessage[];
  }): Promise<void> => {
    await quiescence.whenQuiescent();
    const s = step;
    if (!s) {
      throw new Error("[chat-runner] onStepFinish without an active step — sequencing broke");
    }
    if (result.sessionGone) return;
    const text = s.text.join("");
    const slice = [
      ...info.initialResponseMessages,
      ...stripOwnClientToolResults(info.responseMessages, s.executedIds),
    ];
    const persistedToolCalls = [...s.serverCalls, ...s.clientCalls];

    if (s.anchorMessageId) {
      if (slice.length > 0) {
        const stamped = await setResponseMessages(registry, adapter, humanCtx, {
          messageId: s.anchorMessageId,
          responseMessages: slice,
        });
        if (!stamped) {
          // Row stays on the reconstruction lane — replay still works, the
          // canonical slice is lost for this step. Loud, never silent.
          console.error("[chat-runner] failed to stamp step response_messages", {
            chatSessionId: args.chatSessionId,
            step: s.index,
          });
        }
      }
    } else if (text.trim().length > 0 || persistedToolCalls.length > 0 || slice.length > 0) {
      const saved = await persistAssistantTurn(registry, adapter, humanCtx, {
        chatSessionId: args.chatSessionId,
        content: text,
        toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : null,
        thinkingBlocks: s.thinking.length > 0 ? s.thinking : null,
        responseMessages: slice.length > 0 ? slice : null,
        status: "complete",
      });
      if (saved.ok) {
        result.lastAssistantMessageId = saved.messageId;
        queue.push({ kind: "assistant-message-saved", messageId: saved.messageId });
      } else if (saved.sessionGone) {
        console.warn("[chat-runner] session gone mid-run; terminating quietly", {
          chatSessionId: args.chatSessionId,
        });
        result.sessionGone = true;
        return;
      } else {
        console.error("[chat-runner] failed to persist assistant message", {
          chatSessionId: args.chatSessionId,
          error: saved.message,
        });
        queue.push({
          kind: "error",
          message: `Failed to save assistant message: ${saved.message}`,
        });
        result.persistFailureMessage = saved.message;
        return;
      }
    } else {
      console.error("[chat-runner] empty completed step — nothing persisted", {
        chatSessionId: args.chatSessionId,
        step: s.index,
        finishReason: info.finishReason,
        thinkingBlocks: s.thinking.length,
      });
    }

    // In-memory history, canonical order: assistant entry → tool rows →
    // deferred image user messages. Same Option-C recomposition the DB
    // replay produces, so continuation-step request bytes match a fresh
    // cross-turn call exactly.
    if (slice.length > 0) {
      history.messages.push({ role: "assistant", content: text, sdkMessages: slice });
    } else if (text.trim().length > 0 || persistedToolCalls.length > 0) {
      history.messages.push({
        role: "assistant",
        content: text,
        toolCalls: s.clientCalls.length > 0 ? s.clientCalls : undefined,
        ...(s.serverCalls.length > 0 ? { serverToolCalls: s.serverCalls } : {}),
        ...(s.thinking.length > 0 ? { thinkingBlocks: s.thinking } : {}),
      });
    }
    history.messages.push(...s.toolRows, ...s.deferredImages);

    // Breaker bookkeeping: count exact (tool + args + error) repeats; on the
    // recording that first crosses the threshold, inject ONE corrective
    // nudge so the model changes approach instead of re-sending the same
    // failing call until a cap trips. Origins feed the proactive per-step
    // tool-result compaction (issue #300).
    for (const outcome of s.outcomes) {
      args.toolResultOrigins.set(outcome.toolCallId, { loop: s.index, ok: outcome.ok });
      if (outcome.ok) continue;
      const { tripped, count } = args.failureTracker.record(outcome);
      if (tripped) {
        console.error("[chat-runner] repeated-identical-failure", {
          chatSessionId: args.chatSessionId,
          toolName: outcome.name,
          count,
        });
        history.messages.push({ role: "user", content: repeatedFailureNudge(outcome.name, count) });
      }
    }

    // Turn-level DETECT (issue #106): record what KIND of work the step did.
    for (const call of s.clientCalls) args.turnToolNames.push(call.name);
    if (!args.turnState.hasWritten && s.clientCalls.some((c) => isWriteTool(c.name))) {
      args.turnState.hasWritten = true;
    }

    // Per-step cost attribution trace (the auditable per-loop numbers).
    const inThisStep = args.usage.totalIn - s.usageBefore.in;
    const cacheReadThisStep = args.usage.totalCached - s.usageBefore.cached;
    const cacheWriteThisStep = (args.usage.totalCacheCreation ?? 0) - s.usageBefore.creation;
    console.error("[chat-runner] loop", {
      chatSessionId: args.chatSessionId,
      loop: s.index,
      loopStop: info.finishReason,
      toolCalls: s.clientCalls.length,
      toolNames: s.clientCalls.map((c) => c.name),
      serverToolCalls: s.serverCalls.length,
      serverToolNames: s.serverCalls.map((c) => c.name),
      textChars: text.length,
      thinkingBlocks: s.thinking.length,
      inThisCall: inThisStep,
      cacheRead: cacheReadThisStep,
      cacheWrite: cacheWriteThisStep,
      freshIn: inThisStep - cacheReadThisStep - cacheWriteThisStep,
      cacheHitPct: inThisStep > 0 ? Math.round((cacheReadThisStep / inThisStep) * 100) : 0,
      outThisCall: args.usage.totalOut - s.usageBefore.out,
      tokensIn: args.usage.totalIn,
      tokensCached: args.usage.totalCached,
      tokensOut: args.usage.totalOut,
    });
    if (s.outcomes.length > 0) {
      console.error("[chat-runner] tool-tokens", {
        chatSessionId: args.chatSessionId,
        loop: s.index,
        results: s.outcomes.map((o) => ({
          name: o.name,
          ok: o.ok,
          tokens: estimateTextTokens(o.content),
        })),
      });
    }

    // Durable per-step prompt trace (off unless CAELO_CHAT_TRACE=1). The
    // console line above says a cache miss HAPPENED; this says WHERE — two
    // records diffed at their first disagreeing message fingerprint name the
    // message that broke the prefix.
    if (loopTracePath() !== null) {
      const { fingerprints, totalImageParts } = fingerprintMessages(history.messages);
      const split = buildContextSplitEstimate({
        systemChunks: args.systemPrompt,
        providerTools: args.filteredTools,
        messages: history.messages,
      });
      appendLoopTrace({
        chatSessionId: args.chatSessionId,
        loop: s.index,
        systemHash: hashOf(args.systemPrompt),
        toolsHash: hashOf(args.filteredTools),
        toolCount: args.filteredTools.length,
        messages: fingerprints,
        totalImageParts,
        split: {
          systemPromptTokens: split.systemPromptTokens,
          toolCatalogueTokens: split.toolCatalogueTokens,
          historyTokens: split.historyTokens,
          totalTokens: split.totalTokens,
        },
        cache: {
          inThisCall: inThisStep,
          read: cacheReadThisStep,
          write: cacheWriteThisStep,
          fresh: inThisStep - cacheReadThisStep - cacheWriteThisStep,
        },
      });
    }

    result.stepsCount += 1;
    result.finalStepText = text;
    result.finalStepClientToolCalls = s.clientCalls.length;
    result.finalStepThinking = s.thinking;
    s.finalized = true;
  };

  const handleProviderEvent = (ev: ProviderEvent): void => {
    quiescence.bump();
    if (!sawFirstEvent) {
      sawFirstEvent = true;
      // Run #10 D5 — time-to-first-event telemetry on EVERY run so a
      // silent-start regression is measurable from logs alone.
      console.error("[chat-runner] provider-first-event", {
        msToFirstEvent: Date.now() - callStartedAt,
        messageCount: history.messages.length,
      });
    }
    switch (ev.kind) {
      case "step-start": {
        beginStep();
        break;
      }
      case "text-delta": {
        step?.text.push(ev.text);
        queue.push({ kind: "text-delta", text: ev.text });
        break;
      }
      case "thinking-delta": {
        queue.push({ kind: "thinking-delta", text: ev.text });
        break;
      }
      case "thinking-stop": {
        // Empty adaptive-thinking blocks are dropped at the source — see the
        // pre-#442 note: persisting one poisons the session replay.
        if (ev.thinking.length > 0 && step) {
          step.thinking.push({ thinking: ev.thinking, signature: ev.signature });
        }
        queue.push({ kind: "thinking-stop", thinking: ev.thinking, signature: ev.signature });
        break;
      }
      case "tool-call": {
        step?.clientCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
        break;
      }
      case "server-tool-call": {
        const call: AccumulatedServerToolCall = {
          id: ev.id,
          name: ev.name,
          arguments: ev.arguments,
          serverExecuted: true,
        };
        step?.serverCalls.push(call);
        serverCallsById.set(ev.id, call);
        break;
      }
      case "server-tool-result": {
        // Attach to its call — possibly emitted in a LATER step than the
        // call (the deferred continuation this migration exists for).
        const call = serverCallsById.get(ev.id);
        if (call) call.result = ev.result;
        break;
      }
      case "tool-approval-request": {
        const req: ApprovalRequest = {
          approvalId: ev.approvalId,
          toolCallId: ev.toolCallId,
          name: ev.name,
          arguments: ev.arguments,
        };
        result.approvalRequests.push(req);
        break;
      }
      case "usage": {
        args.usage.totalIn += ev.inputTokens;
        args.usage.totalOut += ev.outputTokens;
        args.usage.totalCached += ev.cachedTokens;
        args.usage.totalCacheCreation =
          (args.usage.totalCacheCreation ?? 0) + (ev.cacheCreationTokens ?? 0);
        break;
      }
      case "done": {
        result.loopStop = ev.stopReason;
        if (ev.stoppingDiagnostics) result.stoppingDiagnostics = ev.stoppingDiagnostics;
        break;
      }
      case "error": {
        if (aborted()) break;
        result.providerErr = true;
        if (isPromptTooLongError(ev.message)) {
          // issue #261 — swallow the raw context-overflow error; loop.ts
          // compacts + retries, and only surfaces a message if that fails.
          result.promptTooLongMessage = ev.message;
        } else if (/first chunk timeout of \d+ms exceeded/i.test(ev.message)) {
          // issue #442 — the SDK's native first-chunk watchdog (replaces the
          // hand-rolled first-event timer). Nothing is surfaced here;
          // loop.ts owns the one-shot retry + operator messaging.
          result.firstEventTimedOut = true;
          console.error("[chat-runner] provider-first-chunk-timeout", {
            messageCount: history.messages.length,
          });
        } else {
          result.providerErrorMessage = ev.message;
          queue.push({ kind: "error", message: ev.message });
        }
        break;
      }
      case "turn-messages": {
        // Per-step slices own Option-C persistence now; the whole-run
        // assembly is redundant here.
        break;
      }
      default:
        break;
    }
  };

  const pumpDone = (async () => {
    try {
      for await (const ev of provider.generate({
        systemPrompt: args.systemPrompt,
        messages: history.messages,
        tools: wrappedTools,
        abortSignal: args.abortSignal,
        maxTokens: args.maxTokens,
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.thinkingBudget !== null
          ? { thinking: { budgetTokens: args.thinkingBudget } }
          : {}),
        // issue #442 — SDK-native per-step watchdog; the env-tunable default
        // applies when no test override is threaded (limits.ts, 180s).
        firstChunkTimeoutMs: args.firstEventTimeoutMs ?? resolveFirstEventTimeoutMs(),
        loop: {
          prepareStep: async ({ stepIndex, steps }) => {
            if (stepIndex === 0) {
              // The run prologue in loop.ts already prepared the first
              // call's messages (they were converted before this hook could
              // mutate them); only the RECOVER forced tool choice applies.
              return args.forceToolChoiceFirstStep ? { toolChoice: "required" } : undefined;
            }
            await policy.prepareStep({ stepIndex, steps });
            // Always override continuation steps with the current history:
            // one canonical lane (Option-C recomposition) for images,
            // nudges, and compaction alike — and byte-stable request
            // prefixes across steps for the prompt cache.
            return { messages: history.messages };
          },
          onStepFinish,
          stopWhen: async ({ steps }) => {
            if (fatalPersist()) return true;
            // A pending gated approval must pause the run even when a
            // deferred tool-search continuation is outstanding — continuing
            // would replay the unanswered gated tool_use and 400. The
            // dangling search call is healed by the replay-time strip.
            if (steps.some((s) => s.hasApprovalRequests)) return true;
            return await policy.stopWhen({ steps });
          },
        },
      })) {
        handleProviderEvent(ev);
      }
    } catch (e) {
      if (!aborted()) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[chat-runner] provider stream threw", {
          chatSessionId: args.chatSessionId,
          message,
        });
        result.providerErr = true;
        if (/first chunk timeout of \d+ms exceeded/i.test(message)) {
          result.firstEventTimedOut = true;
        } else {
          result.providerErrorMessage = message;
          queue.push({ kind: "error", message });
        }
        result.loopStop = "error";
      }
    } finally {
      queue.close();
    }
  })();

  for await (const ev of queue) yield ev;
  await pumpDone;
  // Defensive: no dispatch should still be pending once the stream closed,
  // but a rejected trailing chain must not become an unhandled rejection.
  await serialDispatch.catch(() => undefined);

  if (step !== null && !(step as StepState).finalized) {
    const s = step as StepState;
    result.pendingStep = {
      text: s.text.join(""),
      thinking: s.thinking,
      serverToolCalls: s.serverCalls,
      clientToolCalls: s.clientCalls,
      anchorMessageId: s.anchorMessageId,
    };
  }
  if (result.sessionGone) result.loopStop = "session_gone";
  return result;
}
