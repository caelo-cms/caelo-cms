// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 — the AI's handles on the shared draft.
 *
 *   stage_changes          Part B: the AI may Stage — merge this chat's
 *                          changes (or all of the operator's open chats)
 *                          into main, build staging, queue the quality
 *                          check. Routine (§11.A): staging is not public and
 *                          the merge is a revertable snapshot. Publish live
 *                          stays the human's click, and nothing else builds
 *                          production (#1154).
 *   undo_this_chat         Part A: drop this chat's unstaged changes from
 *                          the draft. When that would also drop another
 *                          chat's later change, the first call only reports
 *                          the overlap; the confirmed call needs the
 *                          operator's click.
 *   start_isolated_branch  Part A: move this chat (before it changed
 *                          anything) onto its own branch — an explicit
 *                          experiment ("try a redesign") or a site migration.
 */

import { randomUUID } from "node:crypto";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { describeDraftPages } from "../../deploy/draft-pages.js";
import { describeStagedPluginProblems } from "../../deploy/plugin-problems.js";
import { describeUnpublishedLinks } from "../../deploy/unpublished-links.js";
import type { AffectedChat } from "../../draft.js";
import { stageChatSessions } from "../../stage/stage-chats.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { AUDIT_WAIT_MS } from "./quality-audit-tools.js";

const NO_CHAT =
  "this tool works on a chat session — open one first (Power-MCP: caelo_open_session).";

/**
 * The context the draft ops run under: the OPERATOR's. A chat belongs to
 * the operator (`created_by`), and the session/stage/undo ops are scoped to
 * the chat's owner — under the AI actor they would find no chat at all
 * (the browser chat's AI actor is not the chat's creator). The Stage still
 * counts as the AI's: stage_changes passes `stagedBy` (an AI origin), which
 * the audit's fix request names.
 */
function operatorCtx(
  ctx: ExecutionContext,
  toolCtx: { readonly humanCtx?: ExecutionContext },
): ExecutionContext {
  return toolCtx.humanCtx ?? ctx;
}

function describeAffected(list: readonly AffectedChat[]): string {
  return list.map((a) => `chat '${a.title}' (${a.labels.join(", ") || "changes"})`).join("; ");
}

/** stage_changes' answer when the Stage outlasted its wait (#1204). */
const STILL_RUNNING = Symbol("still-running");

/**
 * How long stage_changes waits for the Stage before it answers "still
 * running" (agents without the operator's chat): the same bound as a
 * running audit's read, inside the MCP SDK client's default 60 s request
 * timeout. `CAELO_STAGE_TOOL_WAIT_MS` overrides it (tests).
 */
export function stageToolWaitMs(): number {
  const raw = process.env.CAELO_STAGE_TOOL_WAIT_MS;
  if (raw === undefined) return AUDIT_WAIT_MS;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `CAELO_STAGE_TOOL_WAIT_MS must be a positive integer of milliseconds, got "${raw}"`,
    );
  }
  return parsed;
}

/** The "still running" result: where the build stands and what to call next. */
async function stillRunningResult(
  toolCtx: Parameters<ToolDefinitionWithHandler<unknown>["handler"]>[2],
  opCtx: ExecutionContext,
  deployRunId: string,
): Promise<{ ok: boolean; content: string; value: unknown }> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, opCtx, "deploy.get_run", {
    runId: deployRunId,
  });
  const run = r.ok
    ? (r.value as { run: { progress: { pagesDone: number; pagesTotal: number } | null } | null })
        .run
    : null;
  const where =
    run === null
      ? "it is still merging the chats' changes"
      : run.progress
        ? `${run.progress.pagesDone} of ${run.progress.pagesTotal} pages built`
        : "the build is starting";
  return {
    ok: true,
    content:
      `The Stage is still running on the server (build run ${deployRunId}: ${where}). It continues without this call; ` +
      "do NOT call stage_changes again and do not tell the operator it is staged yet. " +
      `Call get_quality_audit with deployRunId "${deployRunId}": it waits for the build, then for its quality check, and says if the build failed.`,
    value: { deployRunId, status: "running" },
  };
}

const stageInput = z
  .object({
    scope: z
      .enum(["this_chat", "all_my_chats"])
      .default("this_chat")
      .describe(
        "`all_my_chats` = every open chat of the operator with unstaged changes, one build.",
      ),
  })
  .strict();

export const stageChangesTool: ToolDefinitionWithHandler<z.infer<typeof stageInput>> = {
  name: "stage_changes",
  description:
    "Stage: merge this chat's unstaged changes into the site, rebuild the STAGING site (noindex, never visitor-facing), then run the quality check (Lighthouse). Use only when the user asks ('stage it', 'put it on staging', 'publish it') and to re-check your own quality fixes; after other edits, offer the Stage instead.\n" +
    "CORE RULES:\n" +
    "- Other chats' changes to the SAME module/page ride along (result names them -> tell the operator).\n" +
    "- Only status 'published' pages are built; result lists left-out drafts -> `set_pages_status_many` first if they belong on staging.\n" +
    "- REFUSED unless: (1) >=1 published page; (2) a published page serves '/' (`set_home_page`, slug kept); (3) every published page has a meta description (`page.metaDescription` in `build_page`, else ONE `autofill_page_seo_many` call). Covers untouched pages too; the turn-start status note and results of `build_page` / `set_pages_status_many` / `set_home_page` / `autofill_page_seo_many` say 'A Stage would be refused right now' + exact fixes -> do them first, then stage once.\n" +
    "- Does NOT publish: Publish live = operator's click after the check (`get_publish_gate` open?, `get_quality_audit` findings). Never say the change is live.\n" +
    "- Failed build returns the generator's error -> fix, retry; changes stay unstaged until a build succeeds.",
  schema: stageInput,
  handler: async (ctx, input, toolCtx) => {
    if (!toolCtx.chatSessionId) return { ok: false, content: `stage_changes: ${NO_CHAT}` };
    const opCtx = operatorCtx(ctx, toolCtx);
    let ids = [toolCtx.chatSessionId];
    if (input.scope === "all_my_chats") {
      const r = await execute(toolCtx.registry, toolCtx.adapter, opCtx, "chat.list_open_changes", {
        mineOnly: true,
      });
      if (!r.ok) {
        return { ok: false, content: `chat.list_open_changes failed: ${describeError(r.error)}` };
      }
      ids = (r.value as { chats: { chatSessionId: string; pendingCount: number }[] }).chats
        .filter((c) => c.pendingCount > 0)
        .map((c) => c.chatSessionId);
      if (ids.length === 0) {
        return {
          ok: true,
          content: "Nothing to stage — none of the operator's chats has unstaged changes.",
        };
      }
    }
    // #1204 — the operator's Stop reaches the build only while this call
    // waits for it; a Stage left running past the wait (below) is not
    // stopped by whatever later ends the caller's turn.
    const deployRunId = randomUUID();
    const stop = new AbortController();
    const forwardStop = (): void => stop.abort(toolCtx.abortSignal?.reason);
    if (toolCtx.abortSignal?.aborted) forwardStop();
    toolCtx.abortSignal?.addEventListener("abort", forwardStop, { once: true });
    const staging = stageChatSessions(
      { registry: toolCtx.registry, adapter: toolCtx.adapter },
      opCtx,
      ids,
      {
        // #685 — the chat's fix request says who staged: the Live Edit AI
        // (an operator browser consumes this turn) or another agent (an
        // external MCP agent, or a subagent, which never gets that flag).
        stagedBy: toolCtx.operatorBrowserAttached === true ? "live_edit_ai" : "other_agent",
        deployRunId,
        abortSignal: stop.signal,
      },
    );
    // #1204 — an agent without the operator's chat (Power-MCP, a subagent)
    // gets an answer within its client's request timeout: a long Stage
    // keeps building on the server and the call returns "still running",
    // so the call — and the chat's turn lease it holds — never outlives
    // the caller. The Live Edit chat waits for the Stage, as before.
    const waitMs = toolCtx.operatorBrowserAttached === true ? null : stageToolWaitMs();
    let waited: ReturnType<typeof setTimeout> | undefined;
    const staged =
      waitMs === null
        ? await staging
        : await Promise.race([
            staging,
            new Promise<typeof STILL_RUNNING>((done) => {
              waited = setTimeout(() => done(STILL_RUNNING), waitMs);
            }),
          ]);
    clearTimeout(waited);
    toolCtx.abortSignal?.removeEventListener("abort", forwardStop);
    if (staged === STILL_RUNNING) {
      void staging.then((r) => {
        if (!r.ok) {
          console.error("[stage] a Stage that outlasted its caller's wait failed", {
            deployRunId,
            step: r.error.step,
            message: r.error.message,
          });
        }
      });
      return stillRunningResult(toolCtx, opCtx, deployRunId);
    }
    if (!staged.ok)
      return { ok: false, content: `Stage failed (${staged.error.step}): ${staged.error.message}` };
    const v = staged.value;
    // #678 — a draft page is never built: name them and the next step, so
    // a "successful" Stage does not hide pages the operator expects.
    const draftNote = describeDraftPages(v.draftPages);
    // #724 — a link to such a page leads nowhere on staging (a warning
    // now; Publish live blocks on it).
    const unpublishedNote = describeUnpublishedLinks(v.unpublishedLinks);
    // #1008 — built while an active plugin did not run: staging lacks its
    // output and Publish live refuses this Stage; the operator must hear it.
    const pluginNote = describeStagedPluginProblems(v.pluginProblems);
    const drafts = `${draftNote ? ` ${draftNote}` : ""}${unpublishedNote ? ` ${unpublishedNote}` : ""}${pluginNote ? ` ${pluginNote} Tell the operator.` : ""}`;
    if (v.mergedEntityCount === 0) {
      return {
        ok: true,
        content:
          `Staging rebuilt (run ${v.runId}, ${v.pageCount} page(s)), but there were no unstaged changes to merge.${drafts} ` +
          "Publish live stays the operator's decision.",
        value: v,
      };
    }
    const preview = v.previewUrl ? ` Preview: ${v.previewUrl}.` : "";
    const also =
      v.alsoIncludes.length > 0
        ? ` Also staged, because they changed the same things: ${describeAffected(v.alsoIncludes)}.`
        : "";
    const links =
      v.linkWarnings.length > 0
        ? ` Link warnings (${v.linkWarnings.length}; a link to an unpublished page blocks Publish live — fix those now): ${v.linkWarnings.slice(0, 5).join(" | ")}${v.linkWarnings.length > 5 ? " | … (check_links lists all)" : ""}`
        : "";
    return {
      ok: true,
      content:
        `Staged ${v.mergedEntityCount} change(s) to staging (run ${v.runId}, ${v.pageCount} page(s)).${preview}${also}${links}${drafts} ` +
        (toolCtx.operatorBrowserAttached === true
          ? "The quality check now runs on staging (2–4 minutes); its result appears in this chat, and when it finds problems the operator is asked whether you should fix them — do NOT poll get_quality_audit / get_publish_gate, finish your turn with your summary. "
          : "The quality check now runs on staging (2–4 minutes): call get_quality_audit now (it waits for the result). The target is 100 in every category and zero findings — fix every problem it names, Stage again and re-read until it passes; do not report open problems to the operator as a result, only what you proved cannot be fixed. ") +
        "Publish live is the operator's click (it never happens automatically after a Stage you made); do not say the change is live.",
      value: v,
    };
  },
};

const undoInput = z
  .object({
    confirmOverlap: z
      .boolean()
      .optional()
      .describe(
        "If another chat later changed the same things, the first call changes NOTHING and lists those chats -> tell the operator 'this also undoes X from chat Y', ask. true ONLY after they agree; that call waits for the operator's click.",
      ),
  })
  .strict();

export const undoThisChatTool: ToolDefinitionWithHandler<z.infer<typeof undoInput>> = {
  name: "undo_this_chat",
  description:
    "Undo THIS chat's unstaged changes in the shared draft (since its last Stage) — 'undo that', 'throw this away', 'go back to before this chat'. Staged/published changes -> `propose_revert_*`. Chats on their own experiment/migration branch are discarded from Open changes instead.",
  schema: undoInput,
  needsApproval: (input) => input.confirmOverlap === true,
  approverPermissions: ["content.write"],
  buildApprovalPreview: () => ({
    op: "undo_this_chat",
    effect:
      "Undoes this chat's unstaged changes AND the later changes of the other chats named in the chat, which were built on them.",
  }),
  handler: async (ctx, input, toolCtx) => {
    if (!toolCtx.chatSessionId) return { ok: false, content: `undo_this_chat: ${NO_CHAT}` };
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      operatorCtx(ctx, toolCtx),
      "chat.undo_changes",
      {
        chatSessionId: toolCtx.chatSessionId,
        ...(input.confirmOverlap ? { confirmOverlap: true } : {}),
      },
    );
    if (!r.ok) return { ok: false, content: `chat.undo_changes failed: ${describeError(r.error)}` };
    const v = r.value as {
      applied: boolean;
      undoneSnapshots: number;
      droppedRows: number;
      overlap: AffectedChat[];
    };
    if (!v.applied) {
      return {
        ok: true,
        content:
          `Nothing was undone yet. Undoing this chat would also undo later changes other chats made on top of it: ${describeAffected(v.overlap)}. ` +
          "Tell the operator exactly that and ask whether to go ahead; only if they agree, call undo_this_chat again with confirmOverlap: true.",
        value: v,
      };
    }
    return {
      ok: true,
      content:
        v.undoneSnapshots === 0
          ? "This chat had no unstaged changes — nothing to undo."
          : `Undid this chat's unstaged changes (${v.undoneSnapshots} change set(s)${v.droppedRows > 0 ? `, ${v.droppedRows} new item(s) removed` : ""}).` +
            (v.overlap.length > 0
              ? ` Also undone, as confirmed: ${describeAffected(v.overlap)}.`
              : ""),
      value: v,
    };
  },
};

const isolateInput = z
  .object({
    reason: z
      .enum(["experiment", "migration"])
      .describe(
        "`experiment` = TRY something without touching the shared draft; `migration` = site migration/import.",
      ),
  })
  .strict();

export const startIsolatedBranchTool: ToolDefinitionWithHandler<z.infer<typeof isolateInput>> = {
  name: "start_isolated_branch",
  description:
    "Move THIS chat from the shared draft (chats see each other's unstaged changes) onto its own isolated branch; later calls write there.\n" +
    "USE FOR (call FIRST, before any change): operator explicitly wants to try/experiment ('try a redesign', 'show me an alternative') | starting a site migration (site-migrate skill). Not for ordinary edits.\n" +
    "Only while this chat has no unstaged changes; else ask the operator to start a new experiment chat (Live edit -> New experiment).",
  schema: isolateInput,
  handler: async (ctx, input, toolCtx) => {
    if (!toolCtx.chatSessionId) return { ok: false, content: `start_isolated_branch: ${NO_CHAT}` };
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      operatorCtx(ctx, toolCtx),
      "chat.isolate_session",
      {
        chatSessionId: toolCtx.chatSessionId,
        reason: input.reason,
      },
    );
    if (!r.ok) {
      return { ok: false, content: `chat.isolate_session failed: ${describeError(r.error)}` };
    }
    return {
      ok: true,
      content:
        `This chat now works on its own ${input.reason} branch: nothing it changes from here on shows up in the shared draft or in other chats until it is staged. ` +
        "Tell the operator, then continue the work.",
      value: r.value,
    };
  },
};
