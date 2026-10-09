// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — the Open changes overview: which chat changed what,
 * what each chat holds, and the lock takeovers between them. The operator
 * stages all of their chats or a selection in ONE Stage (one staging build,
 * one quality audit), or discards a chat's unstaged work.
 *
 * Only the operator's own chats can be staged or discarded here — the
 * merge and discard ops refuse another user's chat. Other editors' chats
 * are listed read-only so nobody is surprised by a takeover.
 */

import { describeError, stageChatSessions } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import { describeStagedBuild } from "#lib/server/stage-result.js";
import type { Actions, PageServerLoad } from "./$types";

interface ChangeRef {
  kind: string;
  entityId: string;
  label: string;
  detail?: string;
}

/** One chat row as `chat.list_open_changes` returns it. */
interface OpenChat {
  chatSessionId: string;
  title: string;
  isMine: boolean;
  anchorPageSlug: string | null;
  lastActiveAt: string;
  lastStagedAt: string | null;
  pendingCount: number;
  changes: {
    pending: { pages: ChangeRef[]; globals: ChangeRef[]; lists: ChangeRef[] };
    staged: { pages: ChangeRef[]; globals: ChangeRef[]; lists: ChangeRef[] };
  };
  locks: { entityKind: string; entityId: string; label: string; lockedAt: string }[];
  takeovers: {
    direction: "adopted" | "lost";
    entityKind: string;
    label: string;
    otherChatTitle: string;
    adoptedSnapshotCount: number;
    at: string;
  }[];
}

export const load: PageServerLoad = async ({ locals }) => {
  const user = requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.list_open_changes", {});
  if (!r.ok) {
    // Loud: an empty list here would read as "nothing open" (CLAUDE.md §2).
    console.error("[changes] chat.list_open_changes failed", { error: r.error });
    return {
      chats: [] as OpenChat[],
      loadError: `Could not load the open changes: ${describeError(r.error)}`,
      canStage: user.permissions.has("deploy.trigger"),
    };
  }
  return {
    chats: (r.value as { chats: OpenChat[] }).chats,
    loadError: null as string | null,
    canStage: user.permissions.has("deploy.trigger"),
  };
};

export const actions: Actions = {
  /**
   * Stage the selected chats (or, with `all`, every chat of the operator
   * that has unstaged changes) in one Stage: merge each, build staging
   * once, audit once. Publish live stays a separate step.
   */
  stage: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const listed = await execute(registry, adapter, locals.ctx, "chat.list_open_changes", {
      mineOnly: true,
    });
    if (!listed.ok) {
      return fail(500, { error: `Could not load your open chats: ${describeError(listed.error)}` });
    }
    const stageable = (listed.value as { chats: OpenChat[] }).chats.filter(
      (c) => c.pendingCount > 0,
    );
    const stageableIds = new Set(stageable.map((c) => c.chatSessionId));
    const requested =
      form.get("all") === "1"
        ? [...stageableIds]
        : form.getAll("chatSessionId").map((v) => String(v));
    if (requested.length === 0) {
      return fail(400, { error: "Select at least one chat to stage." });
    }
    const foreign = requested.filter((id) => !stageableIds.has(id));
    if (foreign.length > 0) {
      return fail(400, {
        error:
          "Only your own chats with unstaged changes can be staged here — reload the page; one of the selected chats changed or belongs to another editor.",
      });
    }

    const staged = await stageChatSessions({ adapter, registry }, locals.ctx, requested);
    if (!staged.ok) {
      const chat = stageable.find((c) => c.chatSessionId === staged.error.chatSessionId);
      return fail(500, {
        error: chat ? `${staged.error.message} (chat '${chat.title}')` : staged.error.message,
      });
    }
    const { previewUrl, draftPageCount } = await describeStagedBuild(
      locals.ctx,
      staged.value,
      null,
    );
    return {
      staged: {
        chatCount: staged.value.chats.length,
        pageCount: staged.value.pageCount,
        fileCount: staged.value.fileCount,
        buildId: staged.value.buildId,
        mergedEntityCount: staged.value.mergedEntityCount,
        brokenInternalLinks: [...staged.value.brokenInternalLinks],
        previewUrl,
        draftPageCount,
      },
    };
  },

  /** Throw away one chat's unstaged work and close it (chat.discard_branch). */
  discard: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const chatSessionId = String(form.get("chatSessionId") ?? "");
    if (!chatSessionId) return fail(400, { error: "missing chatSessionId" });
    const r = await execute(registry, adapter, locals.ctx, "chat.discard_branch", {
      chatSessionId,
    });
    if (!r.ok) {
      console.error("[changes] chat.discard_branch failed", { chatSessionId, error: r.error });
      return fail(400, { error: `Could not discard the chat: ${describeError(r.error)}` });
    }
    return { ok: "Chat discarded — its unstaged changes are gone." };
  },
};
