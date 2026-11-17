// SPDX-License-Identifier: MPL-2.0

/**
 * Which conversations a Stage form names. The Draft changes list (Live
 * Edit's Staging menu and Content → Changes) posts one of three shapes:
 *
 *   only=<chat id>        "Stage now" on one conversation
 *   all=1                 "Stage all": every own conversation with draft changes
 *   chatSessionId=<id>…   "Stage selected": the ticked ones
 *
 * Only the operator's own conversations with draft changes can be staged
 * (the merge ops refuse anyone else's), so the selection is checked
 * against that list here: a form from a stale page is refused with what to
 * do, instead of a merge failing halfway.
 */

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/** The chats to stage, or why the form names none that can be. */
export type StageSelection =
  | { readonly ok: true; readonly chatSessionIds: readonly string[] }
  | { readonly ok: false; readonly status: 400 | 500; readonly error: string };

/** Reads the selection a Stage form posts and checks it against the operator's own drafts. */
export async function readStageSelection(
  ctx: ExecutionContext,
  form: FormData,
): Promise<StageSelection> {
  const { adapter, registry } = getQueryContext();
  const listed = await execute(registry, adapter, ctx, "chat.list_open_changes", {
    mineOnly: true,
  });
  if (!listed.ok) {
    return {
      ok: false,
      status: 500,
      error: `Could not load your conversations: ${describeError(listed.error)}`,
    };
  }
  const stageable = new Set(
    (listed.value as { chats: { chatSessionId: string; pendingCount: number }[] }).chats
      .filter((c) => c.pendingCount > 0)
      .map((c) => c.chatSessionId),
  );
  const only = form.get("only");
  const requested =
    typeof only === "string" && only !== ""
      ? [only]
      : form.get("all") === "1"
        ? [...stageable]
        : form.getAll("chatSessionId").map((v) => String(v));
  if (requested.length === 0) {
    return {
      ok: false,
      status: 400,
      error:
        form.get("all") === "1"
          ? "None of your conversations has draft changes to stage."
          : "Select at least one conversation to stage.",
    };
  }
  if (requested.some((id) => !stageable.has(id))) {
    return {
      ok: false,
      status: 400,
      error:
        "Nothing was staged: one of the selected conversations has no draft changes any more or is not yours. Reload the page and stage again.",
    };
  }
  return { ok: true, chatSessionIds: requested };
}
