// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — wait for the operator's decision on a proposal the agent
 * queued, so the gated tool call returns the OUTCOME instead of a bare
 * "queued" note the agent cannot follow up on.
 *
 * The operator approves or rejects in the Caelo admin (usually the Live
 * Edit chat, whose card says the request came from the external agent).
 * The agent never decides — it only reads the outcome via
 * `/api/mcp/approval` (§11.A: no auto-approve, each instance its own click).
 *
 * The wait is bounded (`CAELO_MCP_APPROVAL_WAIT_MS`, default 50s — below
 * the MCP SDK client's default 60s request timeout) so an unattended admin
 * cannot hang an agent and no client times out first; past it the result
 * tells the agent to call `caelo_await_approval` to keep waiting.
 */

/** What `/api/mcp/approval` returns. */
export interface ApprovalOutcome {
  readonly proposalId: string;
  readonly domain: string;
  readonly toolName: string;
  readonly summary: string;
  readonly outcome: "pending" | "applied" | "failed" | "rejected" | "superseded" | "withdrawn";
  readonly detail: string | null;
  readonly decidedAt: string | null;
}

/**
 * Under the MCP SDK client's default 60s request timeout (progress does not
 * reset it unless the client opts in), so an ordinary client always gets
 * the proposal id + the caelo_await_approval hint instead of a timeout.
 */
export const DEFAULT_APPROVAL_WAIT_MS = 50_000;
export const APPROVAL_POLL_INTERVAL_MS = 3_000;

/** The bounded wait, from `CAELO_MCP_APPROVAL_WAIT_MS` (0 = return at once). */
export function resolveApprovalWaitMs(): number {
  const raw = process.env.CAELO_MCP_APPROVAL_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_APPROVAL_WAIT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`CAELO_MCP_APPROVAL_WAIT_MS must be a non-negative integer (ms), got '${raw}'`);
  }
  return parsed;
}

export interface WaitDeps {
  readonly fetchOutcome: () => Promise<ApprovalOutcome>;
  readonly waitMs: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Called after every still-pending poll (keeps progress-aware clients alive). */
  readonly onPending?: (elapsedMs: number) => Promise<void> | void;
}

/** Generic bounded poll: re-fetch every `intervalMs` until `done` or `waitMs` elapsed. */
export async function pollUntil<T>(deps: {
  readonly fetch: () => Promise<T>;
  readonly done: (value: T) => boolean;
  readonly waitMs: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly onPending?: (elapsedMs: number) => Promise<void> | void;
}): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const interval = deps.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  const start = now();
  let value = await deps.fetch();
  while (!deps.done(value) && now() - start < deps.waitMs) {
    await deps.onPending?.(now() - start);
    await sleep(Math.min(interval, Math.max(0, deps.waitMs - (now() - start))));
    value = await deps.fetch();
  }
  return value;
}

/**
 * Polls until the proposal is decided or `waitMs` elapsed; returns the
 * last outcome read (still `pending` on timeout).
 */
export async function waitForApproval(deps: WaitDeps): Promise<ApprovalOutcome> {
  return pollUntil({
    fetch: deps.fetchOutcome,
    done: (o) => o.outcome !== "pending",
    waitMs: deps.waitMs,
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onPending ? { onPending: deps.onPending } : {}),
  });
}

/** The text the agent reads for an outcome — always names its next step. */
export function describeApprovalOutcome(o: ApprovalOutcome): string {
  const what = `proposal ${o.proposalId} (${o.toolName}${o.summary ? `: ${o.summary}` : ""})`;
  const detail = o.detail ? ` Detail: ${o.detail}` : "";
  switch (o.outcome) {
    case "pending":
      return (
        `Still waiting for the operator's decision on ${what}. Nothing is applied yet. ` +
        `Call caelo_await_approval with proposalId "${o.proposalId}" to keep waiting, or continue with ` +
        `work that does not depend on it. Do not re-propose it.`
      );
    case "applied":
      return `APPROVED and applied: the operator approved ${what}; it is now in effect on the draft. Continue your work with it.${detail}`;
    case "failed":
      return `APPROVED but applying it failed: ${what}.${detail} Tell the operator; fix the cause before proposing again.`;
    case "rejected":
      return `REJECTED: the operator rejected ${what}. It was not applied.${detail} Do not retry it unchanged — ask the operator or adjust the plan.`;
    case "superseded":
      return `SUPERSEDED: ${what} was replaced by a newer proposal and not applied.${detail}`;
    case "withdrawn":
      return `WITHDRAWN: ${what} was cancelled and not applied.${detail}`;
  }
}
