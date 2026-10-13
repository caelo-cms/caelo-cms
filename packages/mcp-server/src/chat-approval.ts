// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — caelo_chat: an approval-gated tool pauses the Caelo chat
 * turn on approval cards the operator decides in the Caelo admin (the Live
 * Edit chat shows them as the external agent's request). This is the
 * agent's side of that pause:
 *
 *  1. the caelo_chat reply lists the cards (`pendingApprovals`);
 *  2. the MCP server waits (bounded, `CAELO_MCP_APPROVAL_WAIT_MS`) until the
 *     operator decided every card (`/api/mcp/chat/approval`);
 *  3. it resumes the agent's OWN paused turn (`/api/mcp/chat` with
 *     `resumeApprovals: true`) — the operator's click never starts a Live
 *     Edit AI turn — and returns that turn's reply, which carries the
 *     outcome (applied, or the model's reaction to a rejection);
 *  4. past the bound it returns the cards plus the `caelo_await_approval`
 *     hint, which picks the wait up again.
 *
 * The agent never decides (CLAUDE.md §11.A): every endpoint here only reads
 * the decision or continues after it.
 */

import { pollUntil } from "./approval-wait.js";

/** A card the caelo_chat turn paused on. */
export interface PendingChatApproval {
  readonly approvalId: string;
  readonly toolName: string;
  readonly preview: string;
}

/** What `/api/mcp/chat` returns. */
export interface SendChatResult {
  readonly chatSessionId: string;
  readonly requestId: string;
  readonly assistant: string;
  readonly toolCalls: ReadonlyArray<{ name: string; summary: string; succeeded: boolean }>;
  readonly pendingProposals: number;
  readonly costMicrocents: number;
  readonly pendingApprovals: readonly PendingChatApproval[];
}

/** One card as `/api/mcp/chat/approval` reports it. */
export interface ChatApprovalView {
  readonly approvalId: string;
  readonly toolName: string;
  readonly preview: string;
  readonly status: "pending" | "approved" | "rejected" | "resumed" | "superseded";
  readonly approved: boolean | null;
  readonly reason: string | null;
}

/** What `/api/mcp/chat/approval` returns. */
export interface ChatApprovalState {
  readonly state: "pending" | "decided" | "superseded" | "none";
  readonly approvals: readonly ChatApprovalView[];
}

export interface SettleDeps {
  readonly chatSessionId: string;
  readonly fetchState: () => Promise<ChatApprovalState>;
  /** Resume the agent's paused turn with the operator's decisions. */
  readonly resume: () => Promise<SendChatResult>;
  /** The whole call's budget: waiting AND the resumed turn must fit in it. */
  readonly waitMs: number;
  /**
   * Time kept back for the resumed turn (its HTTP timeout). A decision seen
   * later than `waitMs - resumeReserveMs` is not resumed in this call — the
   * result says to continue with caelo_await_approval — so the call never
   * outlives the MCP client's request timeout while approved work runs on
   * without a reader (codex review).
   */
  readonly resumeReserveMs: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly onPending?: (elapsedMs: number) => Promise<void> | void;
}

/** Where the paused turn stands after waiting. */
export type SettleResult =
  | {
      /** Every pause was decided and resumed; `turns` are the resumed replies. */
      readonly kind: "settled";
      readonly decided: readonly ChatApprovalView[];
      readonly turns: readonly SendChatResult[];
    }
  | {
      /** The bound ran out with cards undecided. */
      readonly kind: "pending";
      readonly decided: readonly ChatApprovalView[];
      readonly turns: readonly SendChatResult[];
      readonly waiting: readonly ChatApprovalView[];
    }
  | {
      /** Every card is decided, but too little budget is left to resume now. */
      readonly kind: "ready";
      readonly decided: readonly ChatApprovalView[];
      readonly turns: readonly SendChatResult[];
    }
  | {
      /** A newer message moved the chat past the paused turn. */
      readonly kind: "superseded";
      readonly decided: readonly ChatApprovalView[];
      readonly turns: readonly SendChatResult[];
      readonly dropped: readonly ChatApprovalView[];
    };

/**
 * Wait for the operator's decisions and resume the paused turn — again for
 * every further pause the resumed turn hits — within one shared bound.
 */
export async function settleChatApprovals(deps: SettleDeps): Promise<SettleResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + deps.waitMs;
  // Decisions are waited for only while a resume still fits after them.
  const pollDeadline = deadline - deps.resumeReserveMs;
  const decided: ChatApprovalView[] = [];
  const turns: SendChatResult[] = [];
  let fetches = 0;
  const fetchState = async (): Promise<ChatApprovalState> => {
    fetches += 1;
    return deps.fetchState();
  };
  for (;;) {
    const start = now();
    const state = await pollUntil({
      fetch: fetchState,
      done: (s) => s.state !== "pending",
      waitMs: Math.max(0, pollDeadline - start),
      ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      now,
      ...(deps.onPending ? { onPending: deps.onPending } : {}),
    });
    if (state.state === "pending") {
      return { kind: "pending", decided, turns, waiting: state.approvals };
    }
    if (state.state === "superseded") {
      return { kind: "superseded", decided, turns, dropped: state.approvals };
    }
    if (state.state === "none") return { kind: "settled", decided, turns };
    // Decided on this call's very first read: nothing was spent waiting, so
    // the resume always fits. Otherwise only while its reserve is left.
    if (fetches > 1 && deadline - now() < deps.resumeReserveMs) {
      return { kind: "ready", decided, turns };
    }
    decided.push(...state.approvals);
    const resumed = await deps.resume();
    turns.push(resumed);
    if (resumed.pendingApprovals.length === 0) return { kind: "settled", decided, turns };
  }
}

/** One line per decided card, for the agent. */
export function describeDecisions(decided: readonly ChatApprovalView[]): string {
  return decided
    .map((a) =>
      a.approved
        ? `The operator APPROVED ${a.toolName}; your turn continued with it.`
        : `The operator REJECTED ${a.toolName}${a.reason ? ` (reason: ${a.reason})` : ""}; it was not applied.`,
    )
    .join("\n");
}

/** The note for cards the agent is still waiting on — always names the next step. */
export function describeWaiting(
  chatSessionId: string,
  waiting: readonly Pick<ChatApprovalView, "toolName">[],
): string {
  return (
    `Waiting for the operator to approve or reject ${waiting.map((a) => a.toolName).join(", ")} in the Caelo admin. ` +
    `Nothing of it is applied yet. Call caelo_await_approval with chatSessionId "${chatSessionId}" to keep waiting ` +
    "(your turn continues with the decision), or tell your user. Do not send the request again."
  );
}

/** The note when the operator decided but this call has no time left to continue. */
export function describeReady(chatSessionId: string): string {
  return (
    "The operator has decided. Call caelo_await_approval with chatSessionId " +
    `"${chatSessionId}" now to continue your turn with the decision; nothing of it is applied until then.`
  );
}

/** The note for cards a newer message in the chat dropped. */
export function describeSuperseded(dropped: readonly ChatApprovalView[]): string {
  const names = dropped.map((a) => a.toolName).join(", ") || "the gated action";
  return (
    `A newer message in the chat moved on before your turn resumed, so ${names} was not applied. ` +
    "Send it again with caelo_chat if it is still needed."
  );
}
