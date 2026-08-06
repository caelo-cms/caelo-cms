// SPDX-License-Identifier: MPL-2.0

/**
 * issue #442 — the chat-runner's OUTER policy loop. The inner tool loop is
 * the AI SDK's own multi-step loop now (`streamProviderTurn` drives one run
 * per attempt; see streaming.ts and CLAUDE.md §12): the SDK executes tools,
 * consumes provider-deferred tool-search continuations, and calls back into
 * the policy hooks defined here between steps. What remains in this module
 * is everything that spans RUNS or ends the TURN:
 *
 *  - the budget gate (issue #297) — armed pre-run, enforced post-step via
 *    `stopWhen`, with the pause notice + ledger event on trip. G1 note: a
 *    pre-CALL hard stop inside the SDK loop is impossible (prepareStep
 *    cannot stop the run), so enforcement is pre-run + post-step; the worst
 *    case is one step of spend past the ceiling — the bound issue #442
 *    accepted;
 *  - the same-tool runaway guard + the absolute step ceiling (stopWhen);
 *  - compaction (pre-run + per continuation step via prepareStep) and the
 *    #300 proactive tool-result compaction;
 *  - the one-shot retries (G3): first-chunk timeout, prompt-too-long,
 *    empty-at-cap, and the issue-#106 RECOVER forced-tool re-run. Each is
 *    an outer re-invocation seeded from the shared in-memory history —
 *    completed steps are already persisted + appended, so a retry continues
 *    where the failed run stopped instead of redoing the turn;
 *  - the approval epilogue (Plan B): preflight auto-deny + resume, the
 *    e2e auto-approve resume, and the production awaiting_approval pause;
 *  - terminal notices + the turn-fatal bug reports.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import type { AIProvider, ChatMessageInput, ProviderStepSummary } from "../provider.js";
import { capWrapUpNoticeText, shouldWrapUpAtCap } from "../tools/subagent-budget.js";
import { buildApprovalPreview } from "./approval.js";
import { preflightGatedCall } from "./approval-preflight.js";
import {
  type BudgetGateState,
  budgetTripText,
  budgetWarningText,
  evaluateGateLevel,
  fetchBudgetGate,
} from "./budget-gate.js";
import {
  COMPACTION_RECENT_TOKENS_DEFAULT,
  COMPACTION_TARGET_TOKENS_DEFAULT,
  compactHistory,
  estimateHistoryTokens,
  KEEP_RECENT_MESSAGES,
  parsePromptTooLongLimit,
  RETRY_TOOL_RESULT_HEAD_CHARS,
  recentTailCount,
  TOOL_RESULT_HEAD_CHARS,
} from "./compaction.js";
import { costCapUsd, microcents } from "./limits.js";
import { evaluateLoopZeroDiagnostics } from "./passive-turn.js";
import { persistAssistantTurn } from "./persistence.js";
import { compactOldToolResults, type ToolResultOrigin } from "./proactive-compaction.js";
import { fileTurnFatalProviderReport } from "./provider-error-report.js";
import { RepeatedFailureTracker } from "./repeat-failure-guard.js";
import { type RunPolicy, streamProviderTurn, type UsageAccumulator } from "./streaming.js";
import type { FilteredTool } from "./tool-catalogue.js";
import { type JudgeTurnCompleteness, judgeTurnCompleteness } from "./turn-completeness-judge.js";
import type {
  ApprovalRequest,
  ChatRunnerOptions,
  ClientEvent,
  RunChatTurnFn,
  StopReason,
} from "./types.js";

/**
 * The operator message that opened this turn. Scans the turn's STARTING
 * history, not the live one: mid-turn the runner appends `role:"user"` messages
 * to deliver tool images (see `ChatMessageInput.additionalContent`), and those
 * would otherwise be mistaken for the request.
 */
function lastUserRequestText(initialMessages: readonly ChatMessageInput[]): string {
  for (let i = initialMessages.length - 1; i >= 0; i--) {
    const m = initialMessages[i];
    if (m?.role === "user" && m.content.trim().length > 0) return m.content;
  }
  return "";
}

/**
 * Consecutive-same-tool runaway threshold. When the model calls the SAME
 * single tool on this many steps in a row (no varied work in between), the
 * loop stops and names the stuck tool.
 *
 * Root-cause / history: the loop used to hard-stop after a FLAT 25 total
 * iterations ("Paused at the tool-loop limit — reply continue"), which
 * silently paused legitimate long-but-productive work — a migration that
 * builds a homepage, retries, and moves on hits 25 varied iterations and
 * strands the operator on a "continue" prompt. The flat count conflated
 * "doing a lot of DIFFERENT work" (fine, bounded by the budget gate) with
 * "stuck repeating ONE tool" (the actual failure we want to catch). This
 * const is the real runaway signal; overall cost is bounded by the existing
 * live budget gate (budget-gate.ts), and {@link ABSOLUTE_LOOP_CEILING} is a
 * high backstop against a true infinite loop when no budget ceiling is armed.
 */
export const SAME_TOOL_RUNAWAY_LIMIT = 10;

/**
 * Absolute safety ceiling on total loop steps — a backstop against a
 * true infinite loop when no budget ceiling is armed and the same-tool guard
 * never trips (e.g. an endless stream of VARIED tool calls). Deliberately
 * high: varied, productive work should run freely until the model stops or
 * the budget gate pauses it; this only catches pathological non-termination.
 * The default of `runChatTurn`'s `maxToolLoops` (index.ts) resolves to this.
 */
export const ABSOLUTE_LOOP_CEILING = 200;

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
   * `resolveCompactionThresholdTokens()` in index.ts. Default fires near
   * ~800K real input tokens (late, once per long stretch).
   */
  compactionThresholdTokens: number;
  /**
   * Estimate-space landing target once the ceiling fires. Absent ⇒
   * {@link COMPACTION_TARGET_TOKENS_DEFAULT} (~200K real). Separate from
   * the trigger so compaction drops HARD instead of merely back to the
   * trigger (the old cache-thrashing behaviour).
   */
  compactionTargetTokens?: number;
  /**
   * Estimate-space recent-tail budget kept verbatim through a compaction.
   * Absent ⇒ {@link COMPACTION_RECENT_TOKENS_DEFAULT} (~100K real).
   */
  compactionRecentTokens?: number;
  /**
   * issue #300 — enable the proactive per-step tool-result compaction.
   * Default false: it rewrites cached prefix on nearly every step.
   */
  proactiveCompaction?: boolean;
  /**
   * issue #442 — SDK-native per-step first-chunk watchdog window override
   * (tests). Absent ⇒ limits.ts resolves the env-tunable default (180s).
   */
  firstEventTimeoutMs?: number;
  /**
   * issue #106 (redesign) — override the narrate-then-stop completeness judge.
   * Injected so tests can drive the RECOVER layer without an AI provider;
   * production leaves it unset and gets {@link judgeTurnCompleteness}.
   */
  judgeTurnCompleteness?: JudgeTurnCompleteness;
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
  const { registry, adapter, humanCtx, tools, chatSessionId } = args;
  const abortSignal = args.abortSignal;
  const aborted = (): boolean => abortSignal?.aborted === true;

  // The turn's shared in-memory provider history — streaming.ts appends the
  // run's rows; compaction below REPLACES the array (hence the box).
  const history = { messages: [...args.initialMessages] };
  let succeeded = true;
  let stopReason: StopReason = "end_turn";
  let lastAssistantMessageId: string | null = null;

  // Turn-level state shared with streaming.ts across runs.
  const turnToolNames: string[] = [];
  const turnState = { hasWritten: false };
  const failureTracker = new RepeatedFailureTracker();
  const toolResultOrigins = new Map<string, ToolResultOrigin>();
  const stepCounter = { value: 0 };

  // One-shot retry guards (G3 — outer re-invocations of the SDK run).
  let forcedToolRetried = false;
  let forceToolChoice = false;
  let promptTooLongRetried = false;
  let firstEventTimeoutRetried = false;
  let emptyAtCapRetried = false;
  // Run #8 R1 — the retry raises the per-call ceiling (adaptive thinking
  // consumed the whole budget before any visible content; re-running at
  // the same ceiling would likely fail identically).
  let maxOutputTokensThisTurn = args.maxOutputTokens;
  // issue #297 — the import-run cost gate governing this session.
  let budgetGate: BudgetGateState | null = null;
  // issue #304 — one-shot guard for the cost-cap wrap-up notice.
  let capWrapUpNudged = false;
  // v0.10.16/.17/.21 — loop-0 zero-tool diagnostics fire only for the
  // turn's very first provider step.
  let firstRunDone = false;

  // Flags the stopWhen policy sets; the post-run epilogue turns them into
  // notices/stops (stop conditions cannot yield ClientEvents). A holder
  // object, not `let` bindings: TS's outer-scope narrowing ignores closure
  // assignments to captured `let`s, which would type these `null`/`false`
  // forever at the epilogue checks.
  const trip: {
    budgetNotice: string | null;
    costCap: boolean;
    runaway: { name: string; count: number } | null;
    maxLoops: boolean;
  } = { budgetNotice: null, costCap: false, runaway: null, maxLoops: false };
  // Same-tool streak across steps AND runs (a retry must not reset it —
  // pre-#442 the streak survived `loop--; continue` retries too).
  const streak: { name: string | null; count: number } = { name: null, count: 0 };

  const currentTurnMicrocents = (): number =>
    microcents(
      costCapUsd(
        args.usage.totalIn,
        args.usage.totalCached,
        args.usage.totalOut,
        args.inputCost,
        args.outputCost,
      ),
    );

  /**
   * issue #297 — evaluate the live cost gate. On "trip": write the ledger
   * event and stash the pause notice (the epilogue emits + persists it).
   * On "warn": one-shot ledger claim + a persisted system-origin message the
   * model sees on its next step. Returns true on trip.
   */
  const enforceBudgetGate = async (where: string): Promise<boolean> => {
    if (budgetGate === null) return false;
    const { level, liveSpentMicrocents } = evaluateGateLevel(budgetGate, currentTurnMicrocents());
    if (level === "trip") {
      const notice = budgetTripText(budgetGate, liveSpentMicrocents);
      await execute(registry, adapter, humanCtx, "imports.record_budget_gate_event", {
        runId: budgetGate.runId,
        kind: "tripped",
        spentMicrocents: liveSpentMicrocents,
        ceilingMicrocents: budgetGate.ceilingMicrocents,
        message: notice,
      });
      // Correlate via runId + step, never the chat-session id: any form of a
      // session id in a log trips CodeQL's clear-text-logging taint.
      console.error("[chat-runner] budget-gate tripped", {
        where,
        step: stepCounter.value,
        runId: budgetGate.runId,
        liveSpentMicrocents,
        ceilingMicrocents: budgetGate.ceilingMicrocents,
      });
      trip.budgetNotice = notice;
      return true;
    }
    if (level === "warn" && !budgetGate.warningEmitted) {
      const notice = budgetWarningText(budgetGate, liveSpentMicrocents);
      const claim = await execute(registry, adapter, humanCtx, "imports.record_budget_gate_event", {
        runId: budgetGate.runId,
        kind: "warning",
        spentMicrocents: liveSpentMicrocents,
        ceilingMicrocents: budgetGate.ceilingMicrocents,
        message: notice,
      });
      // Local flip either way — losing the claim means another session
      // (parallel subagent) already emitted the warning.
      budgetGate = { ...budgetGate, warningEmitted: true };
      if (claim.ok && (claim.value as { claimed: boolean }).claimed) {
        console.error("[chat-runner] budget-gate warning", {
          chatSessionId,
          step: stepCounter.value,
          runId: budgetGate.runId,
          liveSpentMicrocents,
          ceilingMicrocents: budgetGate.ceilingMicrocents,
        });
        // issue #29 shape — a system-origin status note: muted in the
        // transcript for the operator, a user turn for the model so it
        // economizes the rest of the run.
        await execute(registry, adapter, humanCtx, "chat.append_message", {
          chatSessionId,
          role: "user",
          origin: "system",
          content: notice,
        });
        history.messages = [...history.messages, { role: "user", content: notice }];
      }
    }
    return false;
  };

  /**
   * Emit + persist the budget-pause notice (`trip.budgetNotice`). Shared by
   * the pre-run trip (no provider call started) and the post-run trip (the
   * stopWhen policy paused mid-turn).
   */
  async function* yieldBudgetPause(): AsyncGenerator<ClientEvent, void> {
    const notice = trip.budgetNotice;
    if (notice === null) return;
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

  /**
   * Pre-call injections shared by the run prologue (first call of a run)
   * and `prepareStep` (every continuation step): proactive tool-result
   * compaction (#300), the subagent cost-cap wrap-up nudge (#304), and the
   * #261 pre-flight compaction. All mutate the shared history, which the
   * next step's messages override picks up.
   */
  const runPreCallInjections = async (): Promise<void> => {
    if (args.proactiveCompaction === true && toolResultOrigins.size > 0) {
      const proactive = compactOldToolResults(history.messages, {
        // Origins record the 1-based step that dispatched a result; the pass
        // runs BEFORE the next step, so its reference point is the step
        // ABOUT to run — stepCounter still holds the last begun step.
        currentLoop: stepCounter.value + 1,
        origins: toolResultOrigins,
      });
      if (proactive.compacted > 0) {
        history.messages = proactive.messages;
        console.error("[chat-runner] proactive-tool-result-compaction", {
          chatSessionId,
          step: stepCounter.value,
          compacted: proactive.compacted,
          charsSaved: proactive.charsSaved,
        });
      }
    }
    // issue #304 — per-child cost-cap wrap-up: at ≥85% of the cap inject ONE
    // system-origin instruction to finish the current work item and submit a
    // partial result, so the 100% stop (which fails the turn) is rarely hit
    // by a cooperative child.
    if (args.costCapMicrocents !== undefined && !capWrapUpNudged) {
      const spentMicrocents = currentTurnMicrocents();
      if (spentMicrocents > 0 && shouldWrapUpAtCap(spentMicrocents, args.costCapMicrocents)) {
        capWrapUpNudged = true;
        const notice = capWrapUpNoticeText(spentMicrocents, args.costCapMicrocents);
        console.error("[chat-runner] cost-cap wrap-up nudge", {
          chatSessionId,
          step: stepCounter.value,
          spentMicrocents,
          costCapMicrocents: args.costCapMicrocents,
        });
        await execute(registry, adapter, humanCtx, "chat.append_message", {
          chatSessionId,
          role: "user",
          origin: "system",
          content: notice,
        });
        history.messages = [...history.messages, { role: "user", content: notice }];
      }
    }
    // issue #261 — pre-flight compaction. Estimated before every call
    // because tool results appended mid-run grow the history between steps,
    // not just between operator turns. In-memory only; the persisted
    // transcript is untouched.
    const preflightEstimate = estimateHistoryTokens(history.messages);
    if (preflightEstimate > args.compactionThresholdTokens) {
      const recentBudget = args.compactionRecentTokens ?? COMPACTION_RECENT_TOKENS_DEFAULT;
      const keepRecentMessages = recentTailCount(history.messages, recentBudget);
      const compacted = compactHistory(history.messages, {
        targetTokens: args.compactionTargetTokens ?? COMPACTION_TARGET_TOKENS_DEFAULT,
        keepRecentMessages,
        toolResultHeadChars: TOOL_RESULT_HEAD_CHARS,
      });
      history.messages = compacted.messages;
      console.error("[chat-runner] history-compacted", {
        chatSessionId,
        step: stepCounter.value,
        estimatedTokensBefore: compacted.estimatedTokensBefore,
        estimatedTokensAfter: compacted.estimatedTokensAfter,
        keepRecentMessages,
        toolResultsTruncated: compacted.toolResultsTruncated,
        summarizedMessages: compacted.summarizedMessages,
      });
    }
  };

  /** Same-tool runaway streak update for one finished step's summary. */
  const updateStreak = (last: ProviderStepSummary): void => {
    const first = last.clientToolNames[0];
    const single =
      first !== undefined && last.clientToolNames.every((n) => n === first) ? first : null;
    if (single !== null && single === streak.name) {
      streak.count += 1;
    } else {
      streak.count = single !== null ? 1 : 0;
      streak.name = single;
    }
  };

  const policy: RunPolicy = {
    // Post-step continuation policy. Only consulted when the SDK would
    // continue (all client calls executed / deferred results pending) —
    // the same moments the pre-#442 loop ran its post-dispatch checks.
    stopWhen: async ({ steps }) => {
      // issue #297 — re-fetch while a gate is active so spend recorded by
      // subagent children mid-turn folds into the roll-up, then enforce
      // against the live turn accumulator too (the OVERSHOOT fix: a single
      // step can jump spend far past the ceiling; pausing here trips the
      // moment it crosses, within the same turn).
      if (budgetGate !== null) {
        budgetGate = await fetchBudgetGate(registry, adapter, humanCtx, chatSessionId);
        if (await enforceBudgetGate("post-step")) return true;
      }
      // P10.5 #3 — subagent soft cost cap. Pre-#442 this aborted mid-stream
      // at the usage event; post-step is the same boundary one step later at
      // most, and stopping cleanly keeps the completed steps persisted.
      if (args.costCapMicrocents !== undefined) {
        const spent = currentTurnMicrocents();
        if (spent > args.costCapMicrocents) {
          trip.costCap = true;
          return true;
        }
      }
      const last = steps[steps.length - 1];
      if (last) {
        updateStreak(last);
        if (streak.name !== null && streak.count >= SAME_TOOL_RUNAWAY_LIMIT) {
          trip.runaway = { name: streak.name, count: streak.count };
          return true;
        }
      }
      if (stepCounter.value >= args.maxLoops) {
        trip.maxLoops = true;
        return true;
      }
      // Pre-#442 parity: only an explicit tool_use stop continues the loop.
      // The SDK's default would continue after ANY step whose client calls
      // executed — but a `max_tokens` stop right after a turn-ending ask
      // (the offer_choices class) must end the turn with the pairing
      // complete, not hand the model a continuation to answer its own
      // question. A deferred tool-search continuation is unaffected: the
      // deferring step always stops on tool_use ("tool-calls").
      if (last && last.finishReason !== "tool-calls") return true;
      return false;
    },
    prepareStep: async () => {
      await runPreCallInjections();
    },
  };

  // Attempt loop — one iteration per SDK run. Retries/resumes `continue`
  // (bounded by their one-shot guards + the attempts backstop); everything
  // else breaks with a terminal stopReason.
  let attempts = 0;
  outer: for (;;) {
    if (aborted()) break;
    attempts += 1;
    if (attempts > args.maxLoops) {
      // Backstop against a pathological resume/deny cycle — same operator
      // contract as the step ceiling below.
      trip.maxLoops = true;
      break;
    }

    // issue #297 — arm/enforce the gate BEFORE the run so a fresh call never
    // starts already over budget (the pre-#442 loop-0 check; prepareStep
    // cannot stop the SDK loop pre-call, so the pre-run seat is this one).
    if (attempts === 1 || budgetGate !== null) {
      budgetGate = await fetchBudgetGate(registry, adapter, humanCtx, chatSessionId);
    }
    if (await enforceBudgetGate("pre-run")) {
      yield* yieldBudgetPause();
      stopReason = "cost_ceiling";
      break;
    }
    await runPreCallInjections();
    if (aborted()) break;

    const consumedForceToolChoice = forceToolChoice;
    forceToolChoice = false;

    const run = yield* streamProviderTurn({
      registry,
      adapter,
      humanCtx,
      aiCtxWithBranch: args.aiCtxWithBranch,
      provider: args.provider,
      tools,
      options: args.options,
      runChatTurn: args.runChatTurn,
      chatSessionId,
      chatBranchId: args.chatBranchId,
      abortSignal,
      systemPrompt: args.systemChunks,
      history,
      filteredTools: args.filteredTools,
      policy,
      forceToolChoiceFirstStep: consumedForceToolChoice,
      stepCounter,
      maxTokens: maxOutputTokensThisTurn,
      temperature: args.temperature,
      thinkingBudget: args.thinkingBudget,
      usage: args.usage,
      ...(args.firstEventTimeoutMs !== undefined
        ? { firstEventTimeoutMs: args.firstEventTimeoutMs }
        : {}),
      failureTracker,
      toolResultOrigins,
      turnToolNames,
      turnState,
    });
    if (run.lastAssistantMessageId !== null) {
      lastAssistantMessageId = run.lastAssistantMessageId;
    }

    // --- terminal classification, in the pre-#442 precedence order ---

    if (run.sessionGone) {
      stopReason = "session_gone";
      succeeded = false;
      break;
    }
    if (run.persistFailureMessage !== null) {
      stopReason = "error";
      succeeded = false;
      break;
    }

    if (aborted()) {
      // Persist the interrupted partial step (unless its anchor row already
      // exists — then the row is there and replay-repair heals any missing
      // tool pairs). Client tool calls whose dispatch never ran are DROPPED
      // from the persisted row (Theme B): their tool_result rows were never
      // written, and an unpaired tool_use poisons the replay.
      const p = run.pendingStep;
      if (p && p.anchorMessageId === null) {
        const saved = await persistAssistantTurn(registry, adapter, humanCtx, {
          chatSessionId,
          content: p.text,
          toolCalls: p.serverToolCalls.length > 0 ? [...p.serverToolCalls] : null,
          thinkingBlocks: p.thinking.length > 0 ? p.thinking : null,
          responseMessages: null,
          status: "interrupted",
        });
        if (saved.ok) {
          lastAssistantMessageId = saved.messageId;
          yield { kind: "assistant-message-saved", messageId: saved.messageId };
        }
      }
      break;
    }

    if (run.providerErr) {
      if (run.firstEventTimedOut) {
        // issue #442 — the SDK's native first-chunk watchdog fired (hung
        // request / dead upstream). One automatic retry replaces the silent
        // run; a second silence in a row becomes a VISIBLE persisted notice.
        if (!firstEventTimeoutRetried) {
          firstEventTimeoutRetried = true;
          console.error("[chat-runner] first-event-timeout-retry", { chatSessionId });
          continue;
        }
        const notice =
          "The AI provider did not start responding (no data at all) within the timeout window, " +
          "twice in a row. This is a provider/network hang, not a content problem — please send " +
          "your message again in a moment.";
        console.error("[chat-runner] first-event-timeout-unrecovered", { chatSessionId });
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
        await fileTurnFatalProviderReport({
          registry,
          adapter,
          ctx: args.aiCtxWithBranch,
          chatSessionId,
          providerMessage: notice,
          messages: history.messages,
        });
        succeeded = false;
        stopReason = "error";
        break;
      }
      if (run.promptTooLongMessage !== null) {
        if (!promptTooLongRetried) {
          // issue #261 — the estimator undercounted. Compact HARDER than
          // pre-flight: target half of the current estimate — guaranteed
          // shrink regardless of estimator error — capped at half the
          // ceiling the provider reported.
          promptTooLongRetried = true;
          const reportedLimit = parsePromptTooLongLimit(run.promptTooLongMessage);
          const retryTarget = Math.floor(
            Math.min(
              estimateHistoryTokens(history.messages) / 2,
              reportedLimit !== null ? reportedLimit / 2 : Number.POSITIVE_INFINITY,
            ),
          );
          const compacted = compactHistory(history.messages, {
            targetTokens: retryTarget,
            keepRecentMessages: KEEP_RECENT_MESSAGES,
            toolResultHeadChars: RETRY_TOOL_RESULT_HEAD_CHARS,
          });
          history.messages = compacted.messages;
          console.error("[chat-runner] prompt-too-long-retry", {
            chatSessionId,
            providerMessage: run.promptTooLongMessage,
            retryTarget,
            estimatedTokensBefore: compacted.estimatedTokensBefore,
            estimatedTokensAfter: compacted.estimatedTokensAfter,
            toolResultsTruncated: compacted.toolResultsTruncated,
            summarizedMessages: compacted.summarizedMessages,
          });
          continue;
        }
        const notice =
          "This conversation exceeded the AI model's context limit. I compacted the older " +
          "history and retried, but the request still did not fit. The session history has " +
          "been compacted — please send your message again; if it still fails, start a new " +
          "chat for the next task.";
        console.error("[chat-runner] prompt-too-long-unrecovered", {
          chatSessionId,
          providerMessage: run.promptTooLongMessage,
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
      // Theme A — file the turn-fatal provider error (the generic 400 class,
      // incl. tool_use/tool_result pairing rejections, and the unrecovered
      // context-overflow) so it lands on /security/bugs with the offending
      // replayed history, not just a transient banner.
      await fileTurnFatalProviderReport({
        registry,
        adapter,
        ctx: args.aiCtxWithBranch,
        chatSessionId,
        providerMessage:
          run.providerErrorMessage ??
          run.promptTooLongMessage ??
          "The AI provider rejected or failed the request.",
        messages: history.messages,
      });
      succeeded = false;
      stopReason = "error";
      break;
    }

    // issue #297 — the stopWhen policy tripped the budget gate mid-run.
    if (trip.budgetNotice !== null) {
      yield* yieldBudgetPause();
      stopReason = "cost_ceiling";
      break;
    }

    // P10.5 #3 — subagent soft cost cap: same terminal contract as the
    // pre-#442 mid-stream abort (turn fails; parent sees the error).
    if (trip.costCap) {
      const message = `cost cap reached: spent ~${currentTurnMicrocents()} µ¢ / cap ${args.costCapMicrocents} µ¢`;
      yield { kind: "error", message };
      await fileTurnFatalProviderReport({
        registry,
        adapter,
        ctx: args.aiCtxWithBranch,
        chatSessionId,
        providerMessage: message,
        messages: history.messages,
      });
      succeeded = false;
      stopReason = "error";
      break;
    }

    // v0.10.16/.17/.21 — loop-0 zero-tool diagnostics: only for the turn's
    // very FIRST provider step, matching the pre-#442 `loop === 0` check.
    if (
      !firstRunDone &&
      run.stepsCount === 1 &&
      run.finalStepClientToolCalls === 0 &&
      run.loopStop === "end_turn"
    ) {
      const warning = evaluateLoopZeroDiagnostics({
        chatSessionId,
        accumulatedText: [run.finalStepText],
        accumulatedThinking: run.finalStepThinking,
        totalIn: args.usage.totalIn,
        totalOut: args.usage.totalOut,
        stoppingDiagnostics: run.stoppingDiagnostics,
      });
      if (warning) yield warning;
    }
    firstRunDone = true;

    // Run #8 R1 — empty content at EXACTLY the output-token cap on the final
    // step. Retry ONCE with a doubled ceiling; if the retry also comes back
    // empty, persist a VISIBLE error notice — no silent empties (§2).
    if (
      run.loopStop === "max_tokens" &&
      run.finalStepText.length === 0 &&
      run.finalStepClientToolCalls === 0
    ) {
      if (!emptyAtCapRetried) {
        emptyAtCapRetried = true;
        maxOutputTokensThisTurn = Math.min(maxOutputTokensThisTurn * 2, 65536);
        console.error("[chat-runner] empty-at-output-cap-retry", {
          chatSessionId,
          previousMaxOutputTokens: args.maxOutputTokens,
          retryMaxOutputTokens: maxOutputTokensThisTurn,
          rawFinishReason: run.stoppingDiagnostics?.rawFinishReason ?? null,
        });
        continue;
      }
      const notice =
        "The AI's response was cut off at its output limit before any visible content was " +
        "produced (internal reasoning consumed the whole budget). I retried once with a larger " +
        "budget and it happened again — please send your message again, or split the request " +
        "into smaller steps.";
      console.error("[chat-runner] empty-at-output-cap-unrecovered", {
        chatSessionId,
        maxOutputTokens: maxOutputTokensThisTurn,
        rawFinishReason: run.stoppingDiagnostics?.rawFinishReason ?? null,
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
      await fileTurnFatalProviderReport({
        registry,
        adapter,
        ctx: args.aiCtxWithBranch,
        chatSessionId,
        providerMessage: notice,
        messages: history.messages,
      });
      stopReason = "error";
      succeeded = false;
      break;
    }

    // Slice 1 (SDK approval gate) — the model called one or more gated
    // tools; the SDK paused before their execute and the run stopped.
    // Co-emitted routine calls already executed + persisted inside the run
    // (the CRITICAL PAIRING guarantee the pre-#442 loop enforced by hand).
    if (run.approvalRequests.length > 0) {
      // Never spend a click on a proposal that cannot apply (see
      // approval-preflight.ts): decline SDK-natively so the model fixes it
      // and the operator never sees a card for it.
      const rejected: ApprovalRequest[] = [];
      const askable: ApprovalRequest[] = [];
      for (const req of run.approvalRequests) {
        const bad = preflightGatedCall(tools, registry, req.name, req.arguments);
        if (bad) {
          console.error("[chat-runner] gated call rejected before asking the operator", {
            chatSessionId,
            tool: req.name,
          });
          history.messages.push({
            role: "tool",
            content: "",
            sdkMessages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool-approval-response",
                    approvalId: req.approvalId,
                    approved: false,
                    reason: bad.reason,
                  },
                ],
              },
            ],
          });
          rejected.push(req);
        } else {
          askable.push(req);
        }
      }
      // Everything failed preflight → nothing to ask; resume so the model
      // can correct itself on the next run.
      if (askable.length === 0 && rejected.length > 0) continue;
      for (const req of askable) {
        yield {
          kind: "tool-approval-request",
          approvalId: req.approvalId,
          toolCallId: req.toolCallId,
          name: req.name,
          arguments: req.arguments,
          preview: buildApprovalPreview(req.name, req.arguments),
        };
      }
      // Autonomous / e2e runs: no human is on the stream to click Approve —
      // append the SDK tool-approval-response and CONTINUE; the next run
      // resumes the paused turn (the SDK executes the gated tool pre-loop).
      if (process.env.CAELO_E2E_AUTO_APPROVE_PROPOSALS === "1") {
        for (const req of run.approvalRequests) {
          history.messages.push({
            role: "tool",
            content: "",
            sdkMessages: [
              {
                role: "tool",
                content: [
                  { type: "tool-approval-response", approvalId: req.approvalId, approved: true },
                ],
              },
            ],
          });
        }
        console.error("[chat-runner] auto-approved (e2e)", {
          chatSessionId,
          approvals: run.approvalRequests.map((r) => r.name),
        });
        continue;
      }
      // Production — pause the turn awaiting the Owner's in-chat decision.
      console.error("[chat-runner] awaiting-approval", {
        chatSessionId,
        approvals: run.approvalRequests.map((r) => ({ name: r.name, id: r.approvalId })),
      });
      stopReason = "awaiting_approval";
      break;
    }

    // Same-tool runaway (stopWhen policy flag → operator notice).
    if (trip.runaway !== null) {
      stopReason = "same_tool_runaway";
      const notice =
        `Stopped — I called \`${trip.runaway.name}\` ${trip.runaway.count} times in a row without ` +
        `making progress. Reply "continue" to let me keep going, or tell me what to change.`;
      // No chat-session id in the log — see the budget-gate log above.
      console.error("[chat-runner] same-tool runaway", {
        toolName: trip.runaway.name,
        consecutiveSameTool: trip.runaway.count,
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
      break;
    }

    // Absolute-ceiling backstop (stopWhen policy flag → operator notice).
    if (trip.maxLoops) {
      stopReason = "max_loops";
      const notice =
        `Paused at the tool-loop limit (${args.maxLoops} iterations). The build was still in progress — ` +
        `reply "continue" to resume, or tell me what to change.`;
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
      break;
    }

    // issue #106 (redesign) — RECOVER layer: the model may have narrated an
    // action and ended the turn without emitting the tool call. A cheap
    // structural pre-filter (final step had zero tool calls, nothing written
    // this turn, tools available) decides whether the SEMANTIC judge is
    // worth a call; recovery is the API's own mechanism — re-run with
    // `toolChoice: "required"` on the first step. Once per turn.
    if (run.finalStepClientToolCalls === 0 && run.loopStop === "end_turn") {
      if (
        !forcedToolRetried &&
        !turnState.hasWritten &&
        args.filteredTools.length > 0 &&
        !aborted()
      ) {
        const judge = args.judgeTurnCompleteness ?? judgeTurnCompleteness;
        const verdict = await judge({
          userRequest: lastUserRequestText(args.initialMessages),
          // A snapshot, not the live array: the turn may keep appending
          // after this call.
          toolNames: [...turnToolNames],
          assistantText: run.finalStepText,
          ...(abortSignal ? { abortSignal } : {}),
        });
        // §7 — the judge is a billable sub-call; attribute it to this chat.
        if (verdict) {
          await execute(registry, adapter, humanCtx, "chat.record_ai_call", {
            chatSessionId,
            parentChatSessionId: chatSessionId,
            provider: verdict.providerName,
            model: verdict.model,
            inputTokens: verdict.inputTokens,
            outputTokens: verdict.outputTokens,
          }).catch(() => undefined);
        }
        // A null verdict means the judge could not decide — declining to
        // force is the safe direction.
        if (verdict && !verdict.finished) {
          forcedToolRetried = true;
          forceToolChoice = true;
          console.error("[chat-runner] narrate-then-stop: forcing a tool call", {
            chatSessionId,
            textChars: run.finalStepText.length,
            judgeReason: verdict.reason,
            rawFinishReason: run.stoppingDiagnostics?.rawFinishReason ?? null,
          });
          continue outer;
        }
      }
      stopReason = run.loopStop;
      break;
    }

    // Clean run end — the SDK stopped because the model finished (or hit
    // max_tokens after completed tool work, which the run already persisted
    // pairing-complete).
    stopReason = run.loopStop;
    break;
  }

  return { stopReason, succeeded, lastAssistantMessageId };
}
