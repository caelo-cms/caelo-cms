// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — pure state rules for the in-chat approval cards a turn
 * paused on (`chat_turn_approvals`, migration 0258). Kept free of database
 * and op imports so both the card ops and `mcp.send_chat` share them
 * without an import cycle.
 */

/** Lifecycle of one card. */
export type TurnApprovalStatus = "pending" | "approved" | "rejected" | "resumed" | "superseded";

/**
 * A card the paused turn still has to pick up: undecided, or decided but not
 * yet resumed. Both keep the turn waiting — the operator may decide between
 * the pause and the moment the caller reads the cards.
 */
export function isOpenCard(status: TurnApprovalStatus): boolean {
  return status === "pending" || status === "approved" || status === "rejected";
}

/**
 * What the caelo_chat caller learns about its paused turn:
 *  - `pending`    — the operator has not decided every card yet;
 *  - `decided`    — every card is decided: resume the turn now;
 *  - `superseded` — a newer message moved the chat past the paused turn;
 *  - `none`       — nothing of this token waits in the chat.
 */
export type ChatApprovalState = "pending" | "decided" | "superseded" | "none";

/** The state of a token's paused turn, from its cards (newest first). */
export function chatApprovalStateOf<T extends { status: TurnApprovalStatus; createdAt: string }>(
  rows: readonly T[],
): { state: ChatApprovalState; approvals: T[] } {
  const open = rows.filter((r) => isOpenCard(r.status));
  if (open.length > 0) {
    return {
      state: open.some((r) => r.status === "pending") ? "pending" : "decided",
      approvals: open,
    };
  }
  const latest = rows[0];
  if (latest?.status === "superseded") {
    return {
      state: "superseded",
      approvals: rows.filter((r) => r.status === "superseded" && r.createdAt === latest.createdAt),
    };
  }
  return { state: "none", approvals: [] };
}
