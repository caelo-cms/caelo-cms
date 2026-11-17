// SPDX-License-Identifier: MPL-2.0

/**
 * Which conversations a Stage form names. The Draft changes list (Live
 * Edit's Staging menu and Content → Changes) posts one of three shapes,
 * and Live Edit's Stage again a fourth:
 *
 *   only=<chat id>               "Stage now" on one conversation
 *   all=1                        "Stage all": every own conversation with draft changes
 *   chatSessionId=<id>…          "Stage selected": the ticked ones
 *   restage=1&chatSessionId=<id> "Stage again": rebuild staging from the site as
 *                                it is, for the chat on screen, which may have
 *                                nothing in draft (#835)
 *
 * The list shapes are checked against the operator's own conversations
 * with draft changes, so a form from a stale page is refused with what to
 * do instead of a merge failing halfway. Stage again names the chat on
 * screen; the Stage flow itself refuses one that is not the operator's
 * own open chat (`selectStageChats`).
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { readOwnDraftChats } from "./own-drafts.js";

/** The chats to stage, or why the form names none that can be. */
export type StageSelection =
  | { readonly ok: true; readonly chatSessionIds: readonly string[] }
  | { readonly ok: false; readonly status: 400 | 500; readonly error: string };

/** Stage again: the one chat the form names, whatever it has in draft. */
function restageSelection(form: FormData): StageSelection | null {
  if (form.get("restage") !== "1") return null;
  const chatSessionId = form.get("chatSessionId");
  if (typeof chatSessionId !== "string" || chatSessionId === "") {
    return { ok: false, status: 400, error: "Stage again names no conversation." };
  }
  return { ok: true, chatSessionIds: [chatSessionId] };
}

/**
 * The list shapes, against the operator's conversations with draft
 * changes (`stageable`). Exported for the unit tests.
 */
export function pickStageSelection(form: FormData, stageable: ReadonlySet<string>): StageSelection {
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

/** Reads the selection a Stage form posts and checks it. */
export async function readStageSelection(
  ctx: ExecutionContext,
  form: FormData,
): Promise<StageSelection> {
  const restage = restageSelection(form);
  if (restage) return restage;
  let stageable: Set<string>;
  try {
    stageable = new Set((await readOwnDraftChats(ctx)).map((c) => c.chatSessionId));
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
  return pickStageSelection(form, stageable);
}
