// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — Draft changes: the operator's own conversations with
 * changes that are not on staging yet, each with what it changed (pages
 * new / changed / removed, site-wide changes). The operator stages one
 * ("Stage now"), the ticked ones or all of them in ONE Stage (one staging
 * build, one quality audit), or discards a conversation's draft changes.
 *
 * Only the operator's own conversations are listed (decision 2026-11-17):
 * those are the ones they can stage or discard; another editor's work is
 * theirs. Live Edit's Staging menu shows the same list (DraftChatList).
 */

import { carryStage, describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import type { DraftChat } from "#lib/components/edit/draft-chats.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import { describeStagedBuild } from "#lib/server/stage-result.js";
import { readStageSelection } from "#lib/server/stage-selection.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();
  const canStage = user.permissions.has("deploy.trigger");
  const r = await execute(registry, adapter, locals.ctx, "chat.list_open_changes", {
    mineOnly: true,
  });
  if (!r.ok) {
    // Loud: an empty list here would read as "nothing in draft" (CLAUDE.md §2).
    console.error("[changes] chat.list_open_changes failed", { error: r.error });
    return {
      chats: [] as DraftChat[],
      loadError: `Could not load your draft changes: ${describeError(r.error)}`,
      canStage,
    };
  }
  // A conversation that only holds locks has nothing to stage.
  const chats: DraftChat[] = (r.value as { chats: DraftChat[] }).chats
    .filter((c) => c.pendingCount > 0)
    .map((c) => ({
      chatSessionId: c.chatSessionId,
      title: c.title,
      branchKind: c.branchKind,
      anchorPageId: c.anchorPageId,
      anchorPagePath: c.anchorPagePath,
      pendingCount: c.pendingCount,
      summary: c.summary,
    }));
  return { chats, loadError: null as string | null, canStage };
};

export const actions: Actions = {
  /**
   * Stage one conversation ("Stage now"), the ticked ones, or all of them
   * (stage-selection.ts) in one Stage: merge each, build staging once,
   * audit once. Publish live stays a separate step.
   */
  stage: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const selection = await readStageSelection(locals.ctx, form);
    if (!selection.ok) return fail(selection.status, { error: selection.error });

    // #1574 — inside the request a carrier job holds open (a closed tab does not stop it).
    const staged = await carryStage({ adapter, registry }, locals.ctx, selection.chatSessionIds);
    if (!staged.ok) return fail(500, { error: staged.error.message });
    const {
      previewUrl,
      previewLabel,
      draftPageCount,
      draftPageTitles,
      unpublishedLinkWarning,
      truncatedListWarning,
      pluginProblemWarning,
      linkNoticeWarning,
    } = await describeStagedBuild(locals.ctx, staged.value, null);
    return {
      staged: {
        chatCount: selection.chatSessionIds.length,
        pageCount: staged.value.pageCount,
        fileCount: staged.value.fileCount,
        buildId: staged.value.buildId,
        mergedEntityCount: staged.value.mergedEntityCount,
        linkWarnings: [...staged.value.linkWarnings],
        alsoIncludes: staged.value.alsoIncludes.map((a) => a.title),
        previewUrl,
        previewLabel,
        draftPageCount,
        draftPageTitles,
        unpublishedLinkWarning,
        truncatedListWarning,
        pluginProblemWarning,
        linkNoticeWarning,
      },
      // #1574 — built without the build carrier (the layout's toast says so).
      ...(staged.warning ? { carrierWarning: staged.warning } : {}),
    };
  },

  /**
   * Throw away one conversation's draft changes and close it
   * (chat.discard_branch). A shared-draft chat whose changes other chats
   * built on is NOT discarded until the operator confirms that those later
   * changes go too.
   */
  discard: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const chatSessionId = String(form.get("chatSessionId") ?? "");
    if (!chatSessionId) return fail(400, { error: "missing chatSessionId" });
    const r = await execute(registry, adapter, locals.ctx, "chat.discard_branch", {
      chatSessionId,
      ...(form.get("confirmOverlap") === "1" ? { confirmOverlap: true } : {}),
    });
    if (!r.ok) {
      console.error("[changes] chat.discard_branch failed", { chatSessionId, error: r.error });
      return fail(400, { error: `Could not discard the conversation: ${describeError(r.error)}` });
    }
    const v = r.value as {
      discarded: boolean;
      overlap: { chatSessionId: string | null; title: string; labels: string[] }[];
    };
    if (!v.discarded) {
      return fail(409, {
        error:
          "Discarding this conversation would also undo later changes other conversations made on top of it: " +
          v.overlap.map((o) => `'${o.title}' (${o.labels.join(", ")})`).join("; ") +
          ". Use “Discard anyway” to undo them too.",
        confirmDiscard: chatSessionId,
      });
    }
    return { ok: "Conversation discarded — its draft changes are gone." };
  },
};
