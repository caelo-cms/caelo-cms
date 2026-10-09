// SPDX-License-Identifier: MPL-2.0

/**
 * One turn at a time per chat session.
 *
 * A chat's history is an ordered conversation: every assistant `tool_use`
 * must be followed by its `tool_result` before the next user message. Two
 * turns running at once on the same session interleave their rows — e.g. a
 * quality fix-round nudge persisted while the running turn's `stage_changes`
 * was still executing landed BETWEEN that tool call and its result. The
 * provider rejects such a history ("tool_use ids were found without
 * tool_result blocks"), and because the rows are persisted, EVERY later turn
 * of that chat fails the same way (PR #624 real-AI run: the homepage chat
 * stopped answering after its second fix round).
 *
 * So a turn waits for the session's previous turn to finish before it
 * persists anything. Waiting (not refusing) keeps auto-sent messages — fix
 * rounds, import nudges — from being lost: they simply run next, on a
 * consistent history. The queue is per admin process; a chat's turns are
 * driven from the instance its browser stream is connected to.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Wait until no earlier turn of `chatSessionId` is running, then hold the
 * session. Returns the release function — call it exactly once when the
 * turn ended (in a `finally`).
 */
export async function acquireChatTurn(chatSessionId: string): Promise<() => void> {
  const previous = tails.get(chatSessionId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(chatSessionId, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (tails.get(chatSessionId) === tail) tails.delete(chatSessionId);
  };
}
