// SPDX-License-Identifier: MPL-2.0

/**
 * P10.5 — `spawn_subagent` (single) and `spawn_subagents` (plural).
 *
 * A subagent is just a chat-runner turn. The handler:
 *   1. Creates an ephemeral chat_sessions row (with subagent_role
 *      flagged; the sidebar filters these out).
 *   2. Calls runChatTurn (via toolCtx.spawnChildChatTurn) with:
 *        - the new chat session id,
 *        - excludedToolNames = {spawn_subagent, spawn_subagents}
 *          (depth cap = 1, expressed as plain configuration),
 *        - allowedToolNames from the spec (issue #264 — hard narrowing,
 *          validated against live tool names before the spawn),
 *        - chatBranchIdOverride = the PARENT chat's branch (issue #264 —
 *          the subagent reads and writes the orchestrator's preview
 *          branch, so its edits are visible/publishable/undoable from
 *          the parent chat; the child session's own branch stays unused),
 *        - parent attribution on aiCtx (parent_chat_session_id +
 *          parent_ai_call_id flow into ai_calls writes),
 *      and consumes the AsyncIterable to completion (or timeout).
 *
 *   The child starts with a FRESH context: its transcript is just the
 *   parent-authored task message — parent history is never inherited.
 *   Task briefs must therefore be self-contained (ids, ground-truth
 *   fetch instructions, return-shape contract).
 *   3. Run #10 D2 — collects the child's result from its `submit_result`
 *      tool call (structured channel, validated in the child's own loop
 *      against the shared Zod shapes). The child's final assistant text
 *      is only a legacy fallback; a child that neither submits nor
 *      leaves parseable text gets ONE nudge turn, then a structured
 *      failure.
 *   4. Run #10 D2 — child provider/runtime errors (context limit, cost
 *      cap, stream death) surface as a STRUCTURED `child-error` spawn
 *      failure; they are never fed to the result parser (run #10 saw a
 *      child's own context-limit error string parsed as its "output").
 *   5. Persists a subagent_runs metadata row.
 *   6. Returns the validated result as the parent's tool_result.
 *
 * No special "subagent runtime." Same chat-runner code path. The skill
 * matcher inside the subagent engages whichever skill the task message
 * scores highest against.
 */

import { execute } from "@caelo-cms/query-api";
import {
  EXPECTED_RETURN_SHAPES,
  parseSubagentResult,
  type SpawnSubagentsToolInput,
  type SpawnSubagentToolInput,
  spawnSubagentsToolInput,
  spawnSubagentToolInput,
} from "@caelo-cms/shared";
import { budgetTripText, evaluateGateLevel, fetchBudgetGate } from "../chat-runner/budget-gate.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import {
  type RunBudgetSnapshot,
  runSubagentWaves,
  type SubagentErrorKind,
  type SubagentInvocationResult,
} from "./subagent-batch.js";
import {
  classifyChildCompletion,
  deriveChildCaps,
  pageRefList,
  SUBAGENT_MAX_WAVES,
} from "./subagent-budget.js";

export type {
  SubagentBatchOutcome,
  SubagentBatchProgress,
  SubagentInvocationResult,
} from "./subagent-batch.js";
// issue #268/#304 — the batch/wave core and its types moved to
// subagent-batch.ts (unit-tested there); re-exported so existing imports
// (spawn-subagent-batch.test.ts and friends) keep resolving.
export { runSubagentBatch } from "./subagent-batch.js";

const EXCLUDED_FOR_CHILD = new Set(["spawn_subagent", "spawn_subagents"]);

/**
 * issue #268 — parse an OPTIONAL numeric env override to a finite
 * integer `>= min`. A raw `Number(process.env.X ?? "…")` turns a typo
 * (`SUBAGENT_MAX_PARALLEL=six`) into `NaN`, which then silently poisons
 * everything downstream: `maxItems: NaN` in the provider JSON schema,
 * `Math.min(NaN, …)` in the pool sizing, and every `>`/`<` budget
 * comparison (all false against NaN → the cap never fires). None of
 * those fail loudly — they just misbehave.
 *
 * We do NOT hard-throw at module load. These are optional tuning knobs,
 * and this constant initializes at import time on the admin's hot path;
 * a single bad env var must not make importing this module throw and
 * take down ALL AI functionality. Instead we fall back to the vetted
 * default and `console.warn` LOUDLY, naming the offending var + value so
 * the operator can fix it — loud, not silent (CLAUDE.md §2). `min`
 * guards against `0`/negatives (a 0 concurrency cap would deadlock the
 * pool; a 0 cost cap would abort every batch immediately).
 *
 * @param name the env var to read.
 * @param defaultValue the vetted fallback used when unset or malformed.
 * @param min the smallest accepted value (default 1).
 */
export function parsePositiveIntEnv(name: string, defaultValue: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    console.warn(
      `[spawn_subagent] ignoring ${name}=${JSON.stringify(raw)} — expected an integer >= ${min}; ` +
        `falling back to ${defaultValue}. Fix the env var to tune this cap.`,
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * issue #268/#304 — FALLBACK per-wave spend ceiling for a
 * `spawn_subagents` call, used only when NO #297 run ceiling governs the
 * session (with an armed ceiling the wave cap derives from the remaining
 * budget — see deriveChildCaps). Once the running sum of the settled
 * children's `ai_calls` exceeds it, the orchestrator stops STARTING the
 * remaining specs (they resolve as `batch-aborted`).
 *
 * Default $10.00: runs #14/#15 measured 90–167M µ¢ ($0.90–$1.67) of real
 * spend PER page-batch child, so the old $2.00 default could not fund
 * even two real children — every fan-out died into the serial fallback.
 * $10 funds one full wave at the observed band and default parallelism
 * (6 × ~$1.67), while still hard-lining un-ceilinged runaways.
 */
const SUBAGENT_BATCH_CAP_MICROCENTS = parsePositiveIntEnv(
  "SUBAGENT_BATCH_CAP_MICROCENTS",
  1_000_000_000, // $10.00 default
);

/**
 * issue #304 — FALLBACK per-child cost cap, used only when the spec sets
 * no explicit `maxCostMicrocents` AND no #297 run ceiling is armed (with
 * a ceiling the cap derives from the remaining budget).
 *
 * Default $2.50: the empirical per-child band from runs #14/#15 is
 * 90–167M µ¢ ($0.90–$1.67); 250M µ¢ clears the observed high end with
 * ~1.5× headroom. The old default — 50M µ¢ hardcoded in the shared spec
 * schema — sat BELOW the band's floor, so 100% of page-batch children
 * errored at the cap (issue #304's headline failure).
 */
const SUBAGENT_CHILD_CAP_MICROCENTS = parsePositiveIntEnv(
  "SUBAGENT_CHILD_CAP_MICROCENTS",
  250_000_000, // $2.50 default
);

/**
 * issue #268 — max subagents run CONCURRENTLY within one
 * `spawn_subagents` call. A 30-page migration submits its pages as
 * disjoint specs in one call; the orchestrator keeps at most this many
 * child turns in flight at once and drains the rest as slots free up.
 * The cap exists because each child fans out its own provider calls —
 * an unbounded `Promise.all` over 30 children floods the provider's
 * tier limits and gets 429-thrashed. Default 6 (issue #268 target band
 * 5-8); env-tunable.
 */
const SUBAGENT_MAX_PARALLEL = parsePositiveIntEnv("SUBAGENT_MAX_PARALLEL", 6);

/**
 * issue #268 — max specs accepted in ONE `spawn_subagents` call. Larger
 * than the concurrency cap on purpose: the caller hands the whole
 * disjoint page set in one call and the pool (bounded by
 * `SUBAGENT_MAX_PARALLEL`) drains it, so a 30-page migration is one tool
 * call, not five. Env-tunable.
 */
// issue #304 — clamped to the shared Zod schema's hard max(32): an
// env-raised batch size beyond what the validator accepts would re-create
// the #251 drift class (provider schema invites what dispatch rejects).
const SUBAGENT_MAX_BATCH = Math.min(32, parsePositiveIntEnv("SUBAGENT_MAX_BATCH", 32));

/**
 * Run #10 D2 — the per-shape payload sketch for the submit_result
 * instruction. Appended to every task brief (and restated on the nudge
 * turn) so the child knows its result is collected ONLY via the
 * `submit_result` tool, never from trailing free text.
 */
function submitInstructionFor(shape: SpawnSubagentToolInput["expectedReturnShape"]): string {
  const payload = {
    verdict: '{"pass": boolean, "issues": (string|object)[], "suggestions"?: string[]}',
    tree: '{"tree": any[], "rationale"?: string}',
    rebuild:
      '{"pages": [{"pageId"?: uuid, "slug"?: string, "status": "rebuilt"|"skipped"|"failed", "notes"?: string}], ' +
      '"contentNotes"?: string[], "skipped"?: [{"item": string, "reason": string}], "summary"?: string}',
    freeform: '{"text": string} (or a plain string)',
  }[shape];
  return (
    "MANDATORY FINAL STEP: when your work is done, deliver your result by calling the `submit_result` tool " +
    `EXACTLY ONCE with {"result": ${payload}}. ` +
    "Your result is read ONLY from that tool call — plain text at the end of your turn is NOT collected. " +
    "If submit_result rejects your payload, fix the named fields and call it again, then end your turn."
  );
}

/**
 * issue #304 — a spec whose cost cap has been RESOLVED (explicit value,
 * budget-derived, or env fallback). `runOneSubagent` requires this so a
 * child can never run against an undefined cap; both tool handlers (and
 * the wave orchestrator) resolve before spawning.
 */
type ResolvedSubagentSpec = SpawnSubagentToolInput & { maxCostMicrocents: number };

async function runOneSubagent(
  spec: ResolvedSubagentSpec,
  ctx: Parameters<ToolDefinitionWithHandler<unknown>["handler"]>[0],
  toolCtx: Parameters<ToolDefinitionWithHandler<unknown>["handler"]>[2],
  batchId: string,
  parentAiCallId: string | null,
): Promise<SubagentInvocationResult> {
  const startedAt = Date.now();

  if (!toolCtx.adapter || !toolCtx.registry || !toolCtx.spawnChildChatTurn || !toolCtx.humanCtx) {
    return {
      role: spec.role,
      status: "errored",
      resultJson: null,
      costMicrocents: 0,
      durationMs: 0,
      subagentChatSessionId: "",
      errorMessage:
        "spawn_subagent invoked outside a chat-runner context (no provider/registry/spawn factory available)",
    };
  }

  // issue #264 — validate the per-spawn allowlist BEFORE creating the
  // child session. It is a hard filter in the child's tool catalogue
  // (no zero-match fallback there — see buildToolCatalogue), so an
  // allowlist that matches no live tool would strand the subagent with
  // zero tools. Fail here with the fix in the message instead.
  if (spec.allowedToolNames && spec.allowedToolNames.length > 0 && toolCtx.tools) {
    const live = spec.allowedToolNames.filter((n) => toolCtx.tools?.get(n) !== undefined);
    if (live.length === 0) {
      return {
        role: spec.role,
        status: "errored",
        resultJson: null,
        costMicrocents: 0,
        durationMs: Date.now() - startedAt,
        subagentChatSessionId: "",
        errorMessage:
          `allowedToolNames matched no live tool: [${spec.allowedToolNames.join(", ")}]. ` +
          "Use AI tool names (e.g. edit_module, set_page_module_content, list_pages), not Query API op names " +
          "(pages.get, modules.update). Omit allowedToolNames to grant the full catalogue minus the spawn tools.",
      };
    }
  }

  // 1. Create ephemeral chat session for the subagent.
  const sessionR = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    toolCtx.humanCtx,
    "chat.create_session",
    {
      title: `[subagent] ${spec.role}`,
      subagentRole: spec.role,
      parentChatSessionId: toolCtx.chatSessionId ?? null,
    },
  );
  if (!sessionR.ok) {
    return {
      role: spec.role,
      status: "errored",
      resultJson: null,
      costMicrocents: 0,
      durationMs: Date.now() - startedAt,
      subagentChatSessionId: "",
      errorMessage: `failed to create subagent chat session: ${describeError(sessionR.error)}`,
    };
  }
  const subagentChatSessionId = (sessionR.value as { chatSessionId: string }).chatSessionId;

  // 2. Persist a pending subagent_runs row up front so the Owner UI
  //    sees it immediately even if the run hangs.
  const runRow = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "subagent_runs.create_pending",
    {
      parentChatSessionId: toolCtx.chatSessionId ?? null,
      parentMessageId: null, // not threaded through ToolContext today
      subagentChatSessionId,
      batchId,
      role: spec.role,
      task: spec.task,
    },
  );
  const subagentRunId = runRow.ok ? (runRow.value as { id: string }).id : null;

  // 3. Invoke runChatTurn for the child. The spawn factory closes over
  //    the parent's provider + tools registry so we don't need to
  //    rebuild them here.
  const childAiCtx = {
    ...ctx,
    parentChatSessionId: toolCtx.chatSessionId ?? undefined,
    parentAiCallId: parentAiCallId ?? undefined,
  };
  const childHumanCtx = toolCtx.humanCtx;

  // Run #10 D2 — the structured result channel. The child's
  // submit_result tool validates its payload against the shared Zod
  // shape IN the child's own loop (a mismatch bounces back as a failed
  // tool result the child fixes without a parent round-trip); only
  // validated values land here.
  let submittedResult: unknown;
  let resultSubmitted = false;
  const subagentResultCapture = {
    expectedShape: spec.expectedReturnShape,
    submit: (value: unknown): void => {
      submittedResult = value;
      resultSubmitted = true;
    },
  };

  // Drives ONE chat-runner turn in the child session (per-spec timeout
  // via AbortController) and forwards the child's events to the parent's
  // sink. A closure so the submit-nudge retry below can send a
  // follow-up turn into the SAME session — context preserved, prompt
  // cache warm — instead of re-spawning from scratch. Child `error`
  // events are collected so a provider/runtime failure inside the child
  // surfaces as a structured child-error, never as parseable output.
  const runChildTurn = async (
    content: string,
  ): Promise<{ timedOut: boolean; childErrors: string[] } | { error: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
    const childErrors: string[] = [];
    try {
      // `spawnChildChatTurn` presence was checked at the top of this function.
      const stream = toolCtx.spawnChildChatTurn?.({
        chatInput: {
          chatSessionId: subagentChatSessionId,
          content,
          chips: [],
          attachments: [],
          ...(spec.activePageId ? { activePageId: spec.activePageId } : {}),
        },
        aiCtx: childAiCtx,
        humanCtx: childHumanCtx,
        excludedToolNames: EXCLUDED_FOR_CHILD,
        // issue #264 — per-spawn narrowing (hard filter, validated
        // above). Run #10 D2 — submit_result is unioned in so a
        // narrowed child can still deliver its structured result.
        ...(spec.allowedToolNames && spec.allowedToolNames.length > 0
          ? { allowedToolNames: new Set([...spec.allowedToolNames, "submit_result"]) }
          : {}),
        // issue #264 — the child works ON THE PARENT'S BRANCH so its
        // reads see the orchestrator's branched entities and its writes
        // land where the operator previews, publishes, and undoes.
        ...(toolCtx.chatBranchId ? { chatBranchIdOverride: toolCtx.chatBranchId } : {}),
        // P10.5 #3 — pre-emptive cap inside the child's chat-runner.
        costCapMicrocents: spec.maxCostMicrocents,
        // Run #10 D2 — enables submit_result in the child's catalogue.
        subagentResultCapture,
        abortSignal: controller.signal,
      });
      if (!stream) return { error: "spawnChildChatTurn unavailable" };
      // P10.5 #1 — drain the AsyncIterable + forward each child event
      // through the parent's pushClientEvent sink wrapped as a
      // `subagent-event`. The user's chat UI sees the child's progress
      // (text deltas, tool calls, tool results) live instead of a
      // frozen wait. We never re-emit nested subagent-event payloads
      // (depth-1 cap on observability for now).
      for await (const ev of stream as AsyncIterable<{ kind: string }>) {
        if (controller.signal.aborted) {
          return { timedOut: true, childErrors };
        }
        const inner = ev as { kind: string; message?: unknown };
        // Run #10 D2 — an `error` event is the child's own failure
        // (provider 4xx, context limit after compaction, cost cap,
        // dead stream). Recorded so the spawn resolves as a structured
        // child-error instead of parsing whatever text is left behind.
        if (inner.kind === "error" && typeof inner.message === "string") {
          childErrors.push(inner.message);
        }
        if (inner.kind !== "subagent-event" && toolCtx.pushClientEvent) {
          toolCtx.pushClientEvent({
            kind: "subagent-event",
            batchId,
            role: spec.role,
            subagentChatSessionId,
            inner,
          });
        }
      }
      return { timedOut: false, childErrors };
    } catch (e) {
      return { error: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Latest assistant message in the child session (empty string when none). */
  const readFinalAssistantText = async (): Promise<string> => {
    const sessGet = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      // childHumanCtx captured after the top-of-function guard — TS can't
      // carry that narrowing into this closure via toolCtx.humanCtx.
      childHumanCtx,
      "chat.get_session",
      {
        chatSessionId: subagentChatSessionId,
      },
    );
    if (!sessGet.ok) return "";
    const messages = (
      sessGet.value as {
        messages: { role: string; content: string }[];
      }
    ).messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant" && messages[i]?.content) {
        return messages[i]?.content ?? "";
      }
    }
    return "";
  };

  const failErrored = async (
    message: string,
    errorKind: SubagentErrorKind,
  ): Promise<SubagentInvocationResult> => {
    if (subagentRunId) {
      await execute(toolCtx.registry, toolCtx.adapter, ctx, "subagent_runs.finish", {
        id: subagentRunId,
        status: "errored",
        resultJson: null,
        costMicrocents: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: `${errorKind}: ${message}`,
      });
    }
    return {
      role: spec.role,
      status: "errored",
      resultJson: null,
      costMicrocents: 0,
      durationMs: Date.now() - startedAt,
      subagentChatSessionId,
      errorMessage: message,
      errorKind,
    };
  };

  // Run #10 D2 — the submit instruction is appended to EVERY task brief
  // (not left to the parent's discretion): run #10 lost all 5 rebuild
  // spawns to the free-text result channel.
  const firstTurn = await runChildTurn(
    `${spec.task}\n\n${submitInstructionFor(spec.expectedReturnShape)}`,
  );
  if ("error" in firstTurn) {
    return await failErrored(firstTurn.error, "spawn-error");
  }
  let timedOut = firstTurn.timedOut;
  let childErrors = firstTurn.childErrors;

  // Run #10 D2 (supersedes run #8 R2c) — one AUTOMATIC nudge turn when
  // the child finished cleanly but delivered no result: no
  // submit_result call AND no final text that parses under the
  // expected shape. The retry is a follow-up turn in the same session,
  // so the child keeps its context and just has to submit the result
  // it already produced the work for. Erroring/timed-out children are
  // NOT nudged — their failure is surfaced structurally below.
  if (!timedOut && !resultSubmitted && childErrors.length === 0) {
    const firstText = await readFinalAssistantText();
    const firstParse =
      firstText.trim().length > 0 ? parseSubagentResult(firstText, spec.expectedReturnShape) : null;
    if (!firstParse?.ok) {
      console.error("[spawn_subagent] no submit_result; nudging once", {
        role: spec.role,
        subagentChatSessionId,
        expectedReturnShape: spec.expectedReturnShape,
        finalTextChars: firstText.length,
      });
      const retryTurn = await runChildTurn(
        `You have not delivered your result yet — call submit_result NOW. ${submitInstructionFor(spec.expectedReturnShape)}`,
      );
      if ("error" in retryTurn) {
        return await failErrored(retryTurn.error, "spawn-error");
      }
      timedOut = retryTurn.timedOut;
      childErrors = retryTurn.childErrors;
    }
  }

  // Run #10 D2 — a child that failed (provider error, context limit,
  // cost cap, dead stream) without submitting is a CHILD-ERROR: the
  // parent gets the child's own error message in a structured failure,
  // never as something that looks like output to parse.
  if (!resultSubmitted && childErrors.length > 0) {
    return await failErrored(
      `the subagent's session failed before delivering a result — ${childErrors[childErrors.length - 1]}. ` +
        "This is the child's provider/runtime failure, not its output. Recovery: re-spawn with a " +
        "SMALLER task (fewer pages per batch) and/or a higher timeoutMs / maxCostMicrocents.",
      "child-error",
    );
  }

  if (timedOut) {
    if (subagentRunId) {
      await execute(toolCtx.registry, toolCtx.adapter, ctx, "subagent_runs.finish", {
        id: subagentRunId,
        status: "timed_out",
        resultJson: null,
        costMicrocents: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: `subagent timed out after ${spec.timeoutMs}ms`,
      });
    }
    return {
      role: spec.role,
      status: "timed_out",
      resultJson: null,
      costMicrocents: 0,
      durationMs: Date.now() - startedAt,
      subagentChatSessionId,
      errorMessage: `subagent timed out after ${spec.timeoutMs}ms`,
    };
  }

  // 5. Resolve the result: the submit_result channel wins (already
  //    validated in the child's loop); final-text parsing remains as
  //    the legacy fallback for a child that answered in text despite
  //    the instruction.
  let resultJson: unknown;
  let status: "completed" | "partial" | "errored" = "completed";
  let errorMessage: string | undefined;
  let errorKind: SubagentErrorKind | undefined;
  if (resultSubmitted) {
    resultJson = submittedResult;
  } else {
    const finalText = await readFinalAssistantText();
    if (finalText.trim().length === 0) {
      status = "errored";
      errorKind = "empty-result";
      errorMessage =
        "subagent neither called submit_result nor returned final text (after one automatic nudge). " +
        "Recovery: re-spawn with a SMALLER, more explicit task (fewer pages per batch).";
      resultJson = null;
    } else {
      const parsed = parseSubagentResult(finalText, spec.expectedReturnShape);
      if (parsed.ok) {
        resultJson = parsed.value;
      } else {
        status = "errored";
        errorKind = "shape-mismatch";
        errorMessage = parsed.error;
        resultJson = { raw: finalText.slice(0, 4000) };
      }
    }
  }

  // 6. Roll up the subagent's accumulated cost from ai_calls.
  const costR = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    toolCtx.humanCtx,
    "ai_calls.aggregate_for_session",
    {
      chatSessionId: subagentChatSessionId,
    },
  );
  const costMicrocents = costR.ok ? (costR.value as { costMicrocents: number }).costMicrocents : 0;

  // issue #304 — partial-completion instead of error. A child that
  // DELIVERED a result never has that work discarded for cost: when its
  // spend crossed the wrap-up line (≥85% of its cap — the same line that
  // injected the wrap-up notice into its loop) and its rebuild result
  // names unfinished pages, it classifies as PARTIAL and the wave
  // orchestrator re-dispatches exactly the remainder. Only a child that
  // blew its cap WITHOUT submitting anything stays a hard child-error
  // (that path resolves above via childErrors — streaming.ts aborts the
  // turn at 100%).
  let partial: SubagentInvocationResult["partial"];
  if (status === "completed" && resultSubmitted) {
    const cls = classifyChildCompletion({
      costMicrocents,
      capMicrocents: spec.maxCostMicrocents,
      resultJson,
    });
    if (cls.status === "partial" && cls.partial) {
      status = "partial";
      partial = cls.partial;
      errorMessage =
        `stopped at its cost budget after completing ${cls.partial.completedPages.length} ` +
        `page(s); ${cls.partial.remainingPages.length} remain ` +
        `(${pageRefList(cls.partial.remainingPages)}). Completed work is saved.`;
    }
  }

  if (subagentRunId) {
    await execute(toolCtx.registry, toolCtx.adapter, ctx, "subagent_runs.finish", {
      id: subagentRunId,
      status,
      resultJson: resultJson as Record<string, unknown>,
      costMicrocents,
      durationMs: Date.now() - startedAt,
      errorMessage: errorMessage ? `${errorKind ? `${errorKind}: ` : ""}${errorMessage}` : null,
    });
  }

  return {
    role: spec.role,
    status,
    resultJson,
    costMicrocents,
    durationMs: Date.now() - startedAt,
    subagentChatSessionId,
    ...(errorMessage ? { errorMessage } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(partial ? { partial } : {}),
  };
}

/**
 * issue #304 — the wave orchestrator's budget fetcher: the #297 gate
 * state for the PARENT chat session, folded to `remaining / tripped /
 * pauseText`. Returns null (no budget stop, fallback caps) when the tool
 * runs outside a chat-runner context or no ceilinged run governs the
 * session. The parent turn's own in-flight provider spend is not
 * visible here (same bounded approximation #297 documents for
 * subagent children); the parent loop's own gate closes that gap on its
 * next iteration.
 */
function makeFetchRunBudget(
  toolCtx: Parameters<ToolDefinitionWithHandler<unknown>["handler"]>[2],
): (() => Promise<RunBudgetSnapshot | null>) | null {
  const { registry, adapter, humanCtx, chatSessionId } = toolCtx;
  if (!registry || !adapter || !humanCtx || !chatSessionId) return null;
  return async () => {
    const gate = await fetchBudgetGate(registry, adapter, humanCtx, chatSessionId);
    if (gate === null) return null;
    const { level, liveSpentMicrocents } = evaluateGateLevel(gate, 0);
    return {
      remainingMicrocents: gate.ceilingMicrocents - liveSpentMicrocents,
      tripped: level === "trip",
      pauseText: budgetTripText(gate, liveSpentMicrocents),
    };
  };
}

function summarize(results: SubagentInvocationResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const cost = (r.costMicrocents / 1e8).toFixed(4);
    if (r.status === "completed") {
      lines.push(
        `## ${r.role} (completed · ${r.durationMs}ms · $${cost})\n${JSON.stringify(r.resultJson, null, 2)}`,
      );
    } else if (r.status === "partial") {
      // issue #304 — partial is NOT a failure: the child hit its cost
      // budget, finished its current page, and delivered what landed.
      // The wave orchestrator already re-dispatched the remainder where
      // budget allowed; anything still listed as remaining here needs
      // the parent's (or the operator's) attention.
      const sections = [
        `## ${r.role} (partial${r.errorKind ? ` [${r.errorKind}]` : ""} · ${r.durationMs}ms · $${cost})`,
      ];
      if (r.errorMessage) sections.push(r.errorMessage);
      if (r.partial && r.partial.completedPages.length > 0) {
        sections.push(`Completed pages (saved): ${pageRefList(r.partial.completedPages)}`);
      }
      if (r.partial && r.partial.remainingPages.length > 0) {
        sections.push(
          `Remaining pages (NOT built): ${pageRefList(r.partial.remainingPages)}. ` +
            "Re-run these in a fresh spawn_subagents call once budget allows.",
        );
      }
      if (r.resultJson !== null && r.resultJson !== undefined) {
        sections.push(JSON.stringify(r.resultJson, null, 2));
      }
      lines.push(sections.join("\n\n"));
    } else {
      // v0.2.67 — include the subagent's raw output (when present) +
      // a recovery hint so the parent AI can decide whether to retry,
      // re-spawn with `expectedReturnShape: "freeform"`, or surface
      // the underlying message to the user. Pre-v0.2.67 the parent
      // saw only the verdict-shape Zod error and had no way to act on
      // it. The shape-mismatch case sets resultJson = {raw: <first
      // 4k of text>} per the parse-failure path; rendering it lets
      // the parent see what the subagent actually said.
      // Run #10 D2 — the errorKind tag makes the failure class
      // machine-distinguishable for the parent: `child-error` means
      // the CHILD's session failed (its message is a provider/runtime
      // error, not output), vs. the result-channel classes.
      const header = `## ${r.role} (${r.status}${r.errorKind ? ` [${r.errorKind}]` : ""}${r.errorMessage ? ` — ${r.errorMessage}` : ""} · ${r.durationMs}ms · $${cost})`;
      const rawText =
        r.resultJson && typeof r.resultJson === "object" && "raw" in r.resultJson
          ? String((r.resultJson as { raw: unknown }).raw ?? "")
          : "";
      const hint =
        r.status === "errored" && r.errorKind === "shape-mismatch"
          ? 'Recovery: re-spawn this subagent with `expectedReturnShape: "freeform"` to read the raw output, OR adjust the subagent\'s `task` prompt to make the schema fit, OR surface the raw output below directly to the user.'
          : null;
      const sections: string[] = [header];
      if (rawText) {
        sections.push(`Subagent raw output (first 4 KB):\n${rawText}`);
      }
      if (hint) {
        sections.push(hint);
      }
      lines.push(sections.join("\n\n"));
    }
  }
  return lines.join("\n\n");
}

export const spawnSubagentTool: ToolDefinitionWithHandler<SpawnSubagentToolInput> = {
  name: "spawn_subagent",
  description:
    "Spawn ONE subagent to take a fresh, focused angle on a task — its own context window + tool catalogue + auto-engaged skill. The subagent's matcher engages whichever skill its task wording scores highest against (e.g. role='qa', task='QA the new article' → engages qa-check). " +
    "Use spawn_subagents (plural) when you need MULTIPLE angles in parallel. Single is for one-off focused tasks — deeper research, or a bounded WRITE task like rebuilding one page cluster during a migration. " +
    "BLOCKS until the subagent finishes. Returns the subagent's parsed result + cost + duration. " +
    "The subagent starts with a FRESH context — it knows NOTHING about this chat. Its `task` must be fully self-contained (ids, facts, fetch instructions, return-shape contract). It works on THIS chat's preview branch, so its edits show up in this chat's preview/publish/undo. " +
    "TOOL ACCESS: by default the subagent gets the full tool catalogue minus the spawn tools (it CAN write). Pass `allowedToolNames` (AI tool names, e.g. list_pages, edit_module) to narrow it, e.g. to read-only tools for review tasks. " +
    "DO NOT use for one-line edits or quick lookups — use a regular tool. Subagents earn their cost when work is multi-step + needs an isolated reasoning context. " +
    // v0.2.68 — explicit return-shape schemas. Run #10 D2 — the child
    // now delivers its result via a `submit_result` tool call (the
    // submit instruction is appended to the task automatically); the
    // shapes below describe the payload it must submit.
    "RETURN-SHAPE CONTRACT — the subagent delivers its result by calling its `submit_result` tool with a payload matching `expectedReturnShape` (the submit instruction is appended to your task automatically; your task should still explain the fields' semantics): " +
    '"verdict" → {pass: boolean, issues: (string|object)[], suggestions?: string[]}. Use for QA / audit / review tasks ("does X meet Y criteria?"). ' +
    '"tree" → {tree: any[], rationale?: string}. Use for hierarchical-structure tasks (sitemap, nav tree, IA outline). ' +
    '"rebuild" → {pages: [{pageId?: uuid, slug?: string, status: "rebuilt"|"skipped"|"failed", notes?: string}], contentNotes?: string[], skipped?: [{item: string, reason: string}], summary?: string}. Use for migration page-rebuild tasks — the compact per-page summary is all that enters your context. ' +
    '"freeform" → {text: "..."} or plain text (auto-wrapped). Use when the response is prose / narrative without a fixed structure. ' +
    "When in doubt, pick `freeform` — validation can't fail. Pick `verdict`, `tree`, or `rebuild` when you want a machine-checkable structure back.",
  schema: spawnSubagentToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["role", "task"],
    properties: {
      role: { type: "string", minLength: 1, maxLength: 120 },
      task: {
        type: "string",
        minLength: 1,
        maxLength: 8000,
        description:
          "Self-contained brief (ids, facts, fetch instructions). The submit_result instruction for the chosen expectedReturnShape is appended automatically — describe the CONTENT you want in each result field.",
      },
      allowedToolNames: { type: "array", items: { type: "string", maxLength: 120 } },
      expectedReturnShape: {
        type: "string",
        // Run #8 R2a — derived from the shared Zod enum so the provider
        // schema can never drift from what the validator accepts.
        enum: [...EXPECTED_RETURN_SHAPES],
        description:
          "Payload shape the subagent submits via submit_result: verdict={pass:boolean, issues:array, suggestions?:array}; tree={tree:array, rationale?:string}; rebuild={pages:array, contentNotes?:array, skipped?:array, summary?:string}; freeform={text:string} or plain text. PICK FREEFORM for prose results.",
      },
      maxCostMicrocents: {
        type: "integer",
        minimum: 0,
        description:
          "Per-spawn cost cap in microcents (1e8 = $1). USUALLY OMIT — the runtime derives the right cap from the approved run budget (issue #304). Set only for a deliberate tighter/looser bound.",
      },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      activePageId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const batchId = crypto.randomUUID();
    // issue #304 — resolve the child's cost cap: explicit spec value >
    // derived from the armed run budget > env fallback. A tripped run
    // ceiling refuses the spawn with the #297 pause wording instead of
    // burning a doomed child turn.
    const fetchRunBudget = makeFetchRunBudget(toolCtx);
    const budget = fetchRunBudget ? await fetchRunBudget() : null;
    if (budget !== null && (budget.tripped || budget.remainingMicrocents <= 0)) {
      return { ok: false, content: budget.pauseText };
    }
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: budget?.remainingMicrocents ?? null,
      plannedChildren: 1,
      fallbackChildCapMicrocents: SUBAGENT_CHILD_CAP_MICROCENTS,
      fallbackBatchCapMicrocents: SUBAGENT_BATCH_CAP_MICROCENTS,
    });
    const resolved: ResolvedSubagentSpec = {
      ...input,
      maxCostMicrocents: input.maxCostMicrocents ?? caps.perChildCapMicrocents,
    };
    const result = await runOneSubagent(resolved, ctx, toolCtx, batchId, null);
    return {
      // Partial is not ok (there IS unfinished work) but the message +
      // partial payload tell the parent exactly what landed and what to
      // re-dispatch — never a bare "validation failed".
      ok: result.status === "completed",
      content: summarize([result]),
    };
  },
};

export const spawnSubagentsTool: ToolDefinitionWithHandler<SpawnSubagentsToolInput> = {
  name: "spawn_subagents",
  description:
    "Spawn MULTIPLE subagents that run CONCURRENTLY. Each gets its own context window + auto-engaged skill (matcher fires inside each subagent based on its task wording). This tool BLOCKS until all finish and returns ONE bundled result. " +
    "Use this when work splits into independent parcels that can run at the same time — e.g. drafting an article and validating it via QA + legal + brand-voice review (3 parallel verdicts), or the big one: a site migration where each of N pages gets its OWN per-page AI pass, all in flight together instead of one-at-a-time. " +
    "Returns ONE bundled tool result with each subagent's parsed result + cost + duration + a batch cost roll-up, keeping the prompt-cache prefix clean. Each subagent starts FRESH (self-contained task required) and gets the full catalogue minus the spawn tools unless narrowed via allowedToolNames. " +
    // issue #268 — disjoint-work contract. All siblings write to the
    // SAME shared preview branch and the entity-lock system keys on the
    // branch's session, so siblings do NOT lock each other out (they all
    // resolve to the parent session and are all permitted). Per-sibling
    // sub-leasing is the #264 lease work, not this PR — so for now
    // disjointness is the caller's contract, with no lock backstop.
    "DISJOINT-WORK CONTRACT (MANDATORY for WRITE batches): the subagents run at the same time on the SAME preview branch. They do NOT lock each other out — the entity lock is per-branch, and all siblings share this chat's branch — so two subagents writing the SAME module is a silent lost update (last writer wins), not a clean error. Therefore each spec MUST target a DISJOINT set of entities: give each subagent its own page (or its own non-overlapping page batch), and put any shared chrome (header/footer/nav) in exactly ONE dedicated spec. Never let two siblings touch the same module/page. " +
    `Concurrency: up to ${SUBAGENT_MAX_BATCH} specs per call; at most ${SUBAGENT_MAX_PARALLEL} run at once (the rest queue and drain as slots free). ` +
    // issue #304 — budget-derived caps + partial-completion contract.
    "BUDGET: per-child and batch cost caps are derived automatically from the run's approved cost budget — OMIT maxCostMicrocents unless you have a deliberate reason. A child that approaches its cap finishes its current page and returns a PARTIAL result (completed pages are saved); this tool automatically re-dispatches the remainder in follow-up waves while budget remains, so you do NOT need to retry partial children yourself. If the run's cost ceiling is reached, dispatch stops cleanly and the result says how the operator resumes. Live n-of-m progress streams to the operator while the batch runs. " +
    // v0.2.68 / run #10 D2 — same return-shape guidance as
    // spawn_subagent: results arrive via each child's submit_result
    // tool call (instruction auto-appended to each task).
    "RETURN-SHAPE CONTRACT (per subagent) — each subagent delivers its result via its `submit_result` tool, matching its `expectedReturnShape` (the submit instruction is appended to each task automatically): " +
    '"verdict" → {pass: boolean, issues: (string|object)[], suggestions?: string[]}; ' +
    '"tree" → {tree: any[], rationale?: string}; ' +
    '"rebuild" → {pages: [{pageId?, slug?, status: "rebuilt"|"skipped"|"failed", notes?}], contentNotes?: string[], skipped?: [{item, reason}], summary?: string}; ' +
    '"freeform" → {text: string} or raw text. ' +
    "When in doubt, pick `freeform` per-subagent.",
  schema: spawnSubagentsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["subagents"],
    properties: {
      subagents: {
        type: "array",
        minItems: 1,
        // issue #268 — accept the whole disjoint set in one call; the
        // orchestrator caps how many run AT ONCE (SUBAGENT_MAX_PARALLEL).
        maxItems: SUBAGENT_MAX_BATCH,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "task"],
          properties: {
            role: { type: "string", minLength: 1, maxLength: 120 },
            task: {
              type: "string",
              minLength: 1,
              maxLength: 8000,
              description:
                "Self-contained brief (ids, facts, fetch instructions). The submit_result instruction for the chosen expectedReturnShape is appended automatically.",
            },
            allowedToolNames: { type: "array", items: { type: "string", maxLength: 120 } },
            expectedReturnShape: {
              type: "string",
              // Run #8 R2a — derived from the shared Zod enum (see above).
              enum: [...EXPECTED_RETURN_SHAPES],
              description:
                "Payload shape the subagent submits via submit_result: verdict={pass:boolean, issues:array, suggestions?:array}; tree={tree:array, rationale?:string}; rebuild={pages:array, contentNotes?:array, skipped?:array, summary?:string}; freeform={text:string} or plain text. PICK FREEFORM for prose results.",
            },
            maxCostMicrocents: {
              type: "integer",
              minimum: 0,
              description:
                "Per-spawn cost cap in microcents (1e8 = $1). USUALLY OMIT — the runtime derives the right cap from the approved run budget (issue #304).",
            },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
            activePageId: { type: "string", format: "uuid" },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (input.subagents.length > SUBAGENT_MAX_BATCH) {
      return {
        ok: false,
        content: `spawn_subagents accepts at most ${SUBAGENT_MAX_BATCH} subagents per call; got ${input.subagents.length}. Split the work into multiple calls.`,
      };
    }
    const batchId = crypto.randomUUID();

    // issue #268/#304 — the wave orchestrator (unit-tested with a mock
    // spawn) owns concurrency, budget-derived caps, partial re-dispatch,
    // and the between-waves run-budget re-check. Here we wire the real
    // spawn, the real #297 gate read, and the n-of-m progress stream.
    const outcome = await runSubagentWaves(
      input.subagents,
      (spec) =>
        runOneSubagent(
          // The wave orchestrator resolves every cap before dispatch;
          // the fallback here is unreachable belt-and-braces for TS.
          { ...spec, maxCostMicrocents: spec.maxCostMicrocents ?? SUBAGENT_CHILD_CAP_MICROCENTS },
          ctx,
          toolCtx,
          batchId,
          null,
        ),
      {
        maxParallel: SUBAGENT_MAX_PARALLEL,
        fallbackChildCapMicrocents: SUBAGENT_CHILD_CAP_MICROCENTS,
        fallbackBatchCapMicrocents: SUBAGENT_BATCH_CAP_MICROCENTS,
        maxWaves: SUBAGENT_MAX_WAVES,
        fetchRunBudget: makeFetchRunBudget(toolCtx),
        onProgress: (p) => {
          toolCtx.pushClientEvent?.({
            kind: "subagent-batch-progress",
            batchId,
            finished: p.finished,
            total: p.total,
            ran: p.ran,
            totalCostMicrocents: p.totalCostMicrocents,
            lastRole: p.lastRole,
            batchAborted: p.batchAborted,
            // issue #304 — remainder re-dispatches tick as later waves.
            wave: p.wave,
          });
        },
      },
    );

    // issue #268/#304 — the roll-up is ALWAYS reported. The cap line
    // names its provenance: derived from the run budget (the normal
    // migration path) vs the env fallback (un-ceilinged sessions).
    const capLine =
      outcome.capSource === "run-budget"
        ? "caps derived from the run's approved budget"
        : `fallback caps (no run budget armed): child $${(SUBAGENT_CHILD_CAP_MICROCENTS / 1e8).toFixed(2)} / wave $${(SUBAGENT_BATCH_CAP_MICROCENTS / 1e8).toFixed(2)}`;
    const pauseNote = outcome.budgetStopped && outcome.pauseText ? `\n${outcome.pauseText}` : "";
    const fallbackOverNote = outcome.fallbackOverBudget
      ? "\nBATCH COST CAP EXCEEDED (env fallback cap) — treat as over-budget; raise " +
        "SUBAGENT_BATCH_CAP_MICROCENTS only if the higher spend is expected."
      : "";
    const rollUp =
      `\n\n---\nBatch: ${outcome.ran} child run(s) across ${outcome.waves} wave(s) for ` +
      `${input.subagents.length} spec(s) · total cost $${(outcome.totalCostMicrocents / 1e8).toFixed(4)} · ${capLine}` +
      fallbackOverNote +
      pauseNote;

    // `ok` is a hard guard: a run-ceiling stop, a fallback-cap overrun
    // (Copilot #291-1), or ANY spec that did not fully complete
    // (partial remainders included) is not ok — the content above tells
    // the parent exactly what landed and what to do next.
    const allCompleted =
      !outcome.fallbackOverBudget &&
      !outcome.budgetStopped &&
      outcome.results.every((r) => r.status === "completed");
    return { ok: allCompleted, content: summarize(outcome.results) + rollUp };
  },
};
