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
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const EXCLUDED_FOR_CHILD = new Set(["spawn_subagent", "spawn_subagents"]);
const SUBAGENT_BATCH_CAP_MICROCENTS = Number(
  process.env.SUBAGENT_BATCH_CAP_MICROCENTS ?? "200000000", // $2.00 default
);
const SUBAGENT_MAX_PARALLEL = Number(process.env.SUBAGENT_MAX_PARALLEL ?? "8");
/**
 * P10.5 #2 — bounded concurrency. With 8 parallel subagents each
 * making 5 provider calls, naive `Promise.all` floods Anthropic's tier
 * limits and gets 429-thrashed. The semaphore caps simultaneous
 * SUBAGENT INVOCATIONS (each subagent's own provider calls run
 * sequentially inside its chat-runner loop). Defaults to 4; configurable.
 */
const SUBAGENT_PARALLEL_API_LIMIT = Number(process.env.SUBAGENT_PARALLEL_API_LIMIT ?? "4");

/**
 * Tiny p-limit-style semaphore. Avoids a dependency for ~20 LOC.
 */
function createSemaphore(max: number): (fn: () => Promise<unknown>) => Promise<unknown> {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const tryAcquire = (): void => {
        if (active < max) {
          active += 1;
          resolve();
        } else {
          queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    next?.();
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

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
 * Run #10 D2 — structured failure classes for a spawn (CLAUDE.md §11:
 * failure surfaces are AI-actionable). `child-error` is the child's own
 * provider/runtime failure (context limit, cost cap, dead stream) —
 * NEVER parseable-looking output; `empty-result` / `shape-mismatch`
 * are result-channel failures after the automatic nudge retry;
 * `spawn-error` is plumbing (session create, stream threw).
 */
type SubagentErrorKind = "spawn-error" | "child-error" | "empty-result" | "shape-mismatch";

interface SubagentInvocationResult {
  role: string;
  status: "completed" | "errored" | "timed_out";
  resultJson: unknown;
  costMicrocents: number;
  durationMs: number;
  subagentChatSessionId: string;
  errorMessage?: string;
  /** Run #10 D2 — which structured failure class an errored spawn belongs to. */
  errorKind?: SubagentErrorKind;
}

async function runOneSubagent(
  spec: SpawnSubagentToolInput,
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
  let status: "completed" | "errored" = "completed";
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

  if (costMicrocents > spec.maxCostMicrocents) {
    status = "errored";
    errorKind = "child-error";
    errorMessage = `subagent exceeded cost cap: spent ${costMicrocents} / cap ${spec.maxCostMicrocents}`;
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
      maxCostMicrocents: { type: "integer", minimum: 0 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      activePageId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const batchId = crypto.randomUUID();
    const result = await runOneSubagent(input, ctx, toolCtx, batchId, null);
    return {
      ok: result.status === "completed",
      content: summarize([result]),
    };
  },
};

export const spawnSubagentsTool: ToolDefinitionWithHandler<SpawnSubagentsToolInput> = {
  name: "spawn_subagents",
  description:
    "Spawn MULTIPLE subagents in parallel. Each subagent gets its own context window + auto-engaged skill (matcher fires inside each subagent based on its task wording). All subagents run concurrently; this tool BLOCKS until all finish. " +
    "Use this when a task benefits from multiple angles in parallel — e.g. drafting an article and validating it via QA + legal + brand-voice review (3 parallel verdicts), or auditing a structure via a current-state auditor + a fresh-proposal generator (2 parallel angles). " +
    "Returns ONE bundled tool result with each subagent's parsed verdict + cost + duration, keeping the prompt-cache prefix clean. Each subagent starts FRESH (self-contained task required) and gets the full catalogue minus the spawn tools unless narrowed via allowedToolNames. " +
    "Cap: 8 parallel subagents per call. Each subagent has its own per-spawn cost cap (default $0.50) + timeout (default 60s); the batch overall is capped at $2.00 unless overridden via env. " +
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
        maxItems: SUBAGENT_MAX_PARALLEL,
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
            maxCostMicrocents: { type: "integer", minimum: 0 },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
            activePageId: { type: "string", format: "uuid" },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (input.subagents.length > SUBAGENT_MAX_PARALLEL) {
      return {
        ok: false,
        content: `spawn_subagents max parallel = ${SUBAGENT_MAX_PARALLEL}; got ${input.subagents.length}`,
      };
    }
    const batchId = crypto.randomUUID();
    // P10.5 #2 — bounded concurrency. SUBAGENT_PARALLEL_API_LIMIT caps
    // simultaneous in-flight subagents. Specs queue past it; queue
    // drains as earlier ones complete.
    const limit = createSemaphore(SUBAGENT_PARALLEL_API_LIMIT);
    const results = (await Promise.all(
      input.subagents.map((spec) => limit(() => runOneSubagent(spec, ctx, toolCtx, batchId, null))),
    )) as SubagentInvocationResult[];
    const totalCost = results.reduce((sum, r) => sum + r.costMicrocents, 0);
    if (totalCost > SUBAGENT_BATCH_CAP_MICROCENTS) {
      return {
        ok: false,
        content:
          `spawn_subagents batch cost cap exceeded: spent ${totalCost} / cap ${SUBAGENT_BATCH_CAP_MICROCENTS}\n\n` +
          summarize(results),
      };
    }
    const allCompleted = results.every((r) => r.status === "completed");
    return { ok: allCompleted, content: summarize(results) };
  },
};
