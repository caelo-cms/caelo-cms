// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 — the AI's handles on the shared draft.
 *
 *   stage_changes          Part B: the AI may Stage — merge this chat's
 *                          changes (or all of the operator's open chats)
 *                          into main, build staging, queue the quality
 *                          check. Routine (§11.A): staging is not public and
 *                          the merge is a revertable snapshot. Publish live
 *                          stays the human's click; an AI Stage opens a
 *                          production hold so no automatic publish can ship
 *                          it (stage/ai-stage-hold.ts).
 *   undo_this_chat         Part A: drop this chat's unstaged changes from
 *                          the draft. When that would also drop another
 *                          chat's later change, the first call only reports
 *                          the overlap; the confirmed call needs the
 *                          operator's click.
 *   start_isolated_branch  Part A: move this chat (before it changed
 *                          anything) onto its own branch — an explicit
 *                          experiment ("try a redesign") or a site migration.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import type { AffectedChat } from "../../draft.js";
import { stageChatSessions } from "../../stage/stage-chats.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const NO_CHAT =
  "this tool works on a chat session — open one first (Power-MCP: caelo_open_session).";

function describeAffected(list: readonly AffectedChat[]): string {
  return list.map((a) => `chat '${a.title}' (${a.labels.join(", ") || "changes"})`).join("; ");
}

const stageInput = z
  .object({
    scope: z
      .enum(["this_chat", "all_my_chats"])
      .default("this_chat")
      .describe(
        "this_chat (default) = only this chat's unstaged changes; all_my_chats = every open chat of the operator that has unstaged changes (one build).",
      ),
  })
  .strict();

export const stageChangesTool: ToolDefinitionWithHandler<z.infer<typeof stageInput>> = {
  name: "stage_changes",
  description:
    "Stage: merge this chat's unstaged changes into the site and rebuild the STAGING site (noindex, never visitor-facing), then the quality check (Lighthouse) runs on it. " +
    "Use it when the operator's requested change is done and should be reviewed on staging — 'stage it', 'put it on staging', or as the last step of finished work so the operator can review and Publish live. " +
    "Changes another chat made to the SAME module/page ride along (the result names them — tell the operator). scope all_my_chats stages every open chat of the operator at once. " +
    "It does NOT publish: Publish live is the operator's click after the quality check (get_publish_gate says whether it is open; get_quality_audit reads the findings). Never tell the operator the change is live. " +
    "A failed build returns the generator's error — fix the cause and call again; the changes stay unstaged until a build succeeds.",
  schema: stageInput,
  handler: async (ctx, input, toolCtx) => {
    if (!toolCtx.chatSessionId) return { ok: false, content: `stage_changes: ${NO_CHAT}` };
    let ids = [toolCtx.chatSessionId];
    if (input.scope === "all_my_chats") {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.list_open_changes", {
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
    const staged = await stageChatSessions(
      { registry: toolCtx.registry, adapter: toolCtx.adapter },
      ctx,
      ids,
    );
    if (!staged.ok)
      return { ok: false, content: `Stage failed (${staged.error.step}): ${staged.error.message}` };
    const v = staged.value;
    if (v.mergedEntityCount === 0) {
      return {
        ok: true,
        content:
          `Staging rebuilt (run ${v.runId}), but there were no unstaged changes to merge. ` +
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
      v.brokenInternalLinks.length > 0
        ? ` Broken internal links found: ${v.brokenInternalLinks.slice(0, 10).join(", ")} — fix them before publishing.`
        : "";
    return {
      ok: true,
      content:
        `Staged ${v.mergedEntityCount} change(s) to staging (run ${v.runId}, ${v.pageCount} page(s)).${preview}${also}${links} ` +
        "The quality check is queued — read it with get_quality_audit / get_publish_gate. " +
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
        "true ONLY after the operator confirmed that the other chats' later changes named by the previous call may be undone too. Needs the operator's click.",
      ),
  })
  .strict();

export const undoThisChatTool: ToolDefinitionWithHandler<z.infer<typeof undoInput>> = {
  name: "undo_this_chat",
  description:
    "Undo THIS chat's unstaged changes in the shared draft (everything this chat changed since it was last staged; staged/published changes are not touched — those use the propose_revert_* tools). " +
    "Use when the operator says 'undo that', 'throw this away', 'go back to how it was before this chat'. " +
    "If another chat has since changed one of the same things, the first call changes NOTHING and lists those chats: tell the operator 'this also undoes X from chat Y' and ask. Only after the operator agrees call again with confirmOverlap: true — that call waits for the operator's click. " +
    "Chats on their own experiment/migration branch are discarded from Open changes instead.",
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
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.undo_changes", {
      chatSessionId: toolCtx.chatSessionId,
      ...(input.confirmOverlap ? { confirmOverlap: true } : {}),
    });
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
        "experiment = the operator wants to TRY something (a redesign, an alternative) without touching the shared draft; migration = a site migration/import.",
      ),
  })
  .strict();

export const startIsolatedBranchTool: ToolDefinitionWithHandler<z.infer<typeof isolateInput>> = {
  name: "start_isolated_branch",
  description:
    "Move THIS chat onto its own isolated branch before it changes anything. By default every chat works in the site's shared draft, where all chats see each other's unstaged changes. " +
    "Call it FIRST when the operator explicitly asks to try/experiment ('try a redesign', 'show me an alternative version', 'experiment with…') or when you start a site migration (the site-migrate skill says when). Not for ordinary edits. " +
    "Works only while this chat has no unstaged changes; otherwise ask the operator to start a new experiment chat (Live edit → New experiment). Your later calls in this conversation then write to the isolated branch.",
  schema: isolateInput,
  handler: async (ctx, input, toolCtx) => {
    if (!toolCtx.chatSessionId) return { ok: false, content: `start_isolated_branch: ${NO_CHAT}` };
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.isolate_session", {
      chatSessionId: toolCtx.chatSessionId,
      reason: input.reason,
    });
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
