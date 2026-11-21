// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — a chat turn's place in the AI spend ledger.
 *
 * A turn is many provider requests (the SDK's multi-step loop, plus the
 * chat-runner's outer re-runs). It keeps ONE `ai_calls` row: reserved
 * before the turn's first request at that request's worst case, extended
 * before every further request to "what the finished requests cost + the
 * next request's worst case", and settled at the turn's end to the real
 * totals. Each reservation is checked against the site, per-person and
 * per-chat text budgets under the ledger lock, so parallel turns and
 * subagents cannot overshoot a budget together: a request that would not
 * fit never starts.
 *
 * The next request's prompt is bounded by the previous request's real
 * prompt tokens plus whatever was added to the history since (each new
 * byte at most one token, an image at most IMAGE_TOKEN_BOUND), and never
 * by more than a full count of the history.
 *
 * A ledger that cannot be reached is let through once or twice (the turn
 * is then recorded at its end, as before the ledger) and fails closed after
 * LOOKUP_FAIL_THRESHOLD misses in a row (shared/cap-failures.ts).
 */

import type { AiSpender } from "@caelo-cms/plugin-host";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  PROVIDER_REQUEST_OVERHEAD_TOKENS,
  promptTokenBound,
  recordCapLookupFailure,
  recordCapLookupSuccess,
  tokenBoundOf,
} from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../../audit.js";
import type { ChatMessageInput, ProviderStepSummary } from "../provider.js";
import type { UsageAccumulator } from "./streaming.js";

const LEDGER_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "chat-ai-ledger",
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  largestPromptTokens: number;
};

/** Why the turn's next request may not start: the text the operator and the model read. */
export type SpendRefusal = string;

/** The ledger seat of one chat turn. */
export class TurnSpend {
  #callId: string | null = null;
  /** Usage of the turn's runs that ended (the accumulator at the current run's start). */
  #runStart: Usage = zero();
  /** The real prompt tokens of the turn's last finished request, and the history bound it was sent with. */
  #last: { promptTokens: number; historyBound: number } | null = null;
  /** The history bound measured for the request about to run. */
  #pendingHistoryBound = 0;
  /** The ledger could not be reached at the start: record the turn at its end instead. */
  #unaccounted = false;
  /** Requests this turn let go out; each one reports usage, or fails. */
  #sent = 0;

  constructor(
    private readonly deps: { registry: OperationRegistry; adapter: DatabaseAdapter },
    private readonly spenderOf: AiSpender,
    private readonly target: { provider: string; model: string },
    /** What every request sends besides the history: system prompt, tools. */
    private readonly fixed: readonly unknown[],
    private readonly opts: { requestId: string | null; parentAiCallId: string | null },
  ) {}

  /** Who pays for the turn (the judge and other sub-calls charge the same). */
  get spender(): AiSpender {
    return this.spenderOf;
  }

  /** The turn's `ai_calls` row, once reserved. */
  get callId(): string | null {
    return this.#callId;
  }

  /** True when the turn ran without a reservation (the ledger was unreachable). */
  get unaccounted(): boolean {
    return this.#unaccounted;
  }

  /** A new run of the turn starts: what the turn spent so far is in `usage`. */
  startRun(usage: UsageAccumulator): void {
    this.#runStart = fromAccumulator(usage);
  }

  /**
   * Reserve (first request) or extend (every later one) before a request
   * goes out. Null: it may run; a string: it may not, and why.
   *
   * @param steps the current run's finished steps (empty before its first).
   */
  async beforeRequest(
    history: readonly ChatMessageInput[],
    maxOutputTokens: number,
    steps: readonly ProviderStepSummary[] = [],
  ): Promise<SpendRefusal | null> {
    const refusal = await this.#check(history, maxOutputTokens, steps);
    if (refusal === null) this.#sent += 1;
    return refusal;
  }

  async #check(
    history: readonly ChatMessageInput[],
    maxOutputTokens: number,
    steps: readonly ProviderStepSummary[],
  ): Promise<SpendRefusal | null> {
    const historyBound = tokenBoundOf(history);
    const lastStep = steps[steps.length - 1];
    if (lastStep?.usage) {
      // The request that just finished went out with the history measured before it.
      this.#last = {
        promptTokens: lastStep.usage.inputTokens,
        historyBound: this.#pendingHistoryBound,
      };
    }
    this.#pendingHistoryBound = historyBound;
    const full = promptTokenBound(...this.fixed) + historyBound;
    const promptTokens = this.#last
      ? Math.min(
          full,
          this.#last.promptTokens +
            Math.max(0, historyBound - this.#last.historyBound) +
            PROVIDER_REQUEST_OVERHEAD_TOKENS,
        )
      : full;
    const next = { promptTokens, maxOutputTokens };
    if (this.#unaccounted) return null;
    const capKey = `chat:${this.spenderOf.actorId}`;
    const what = "this chat step";
    let r: Awaited<ReturnType<typeof execute>>;
    try {
      r =
        this.#callId === null
          ? await execute(this.deps.registry, this.deps.adapter, LEDGER_CTX, "ai_ledger.reserve", {
              spender: this.spenderOf,
              ...this.target,
              request: next,
              what,
              requestId: this.opts.requestId?.slice(0, 64) ?? null,
              parentAiCallId: this.opts.parentAiCallId,
            })
          : await execute(this.deps.registry, this.deps.adapter, LEDGER_CTX, "ai_ledger.extend", {
              callId: this.#callId,
              spender: this.spenderOf,
              ...this.target,
              used: this.used(steps),
              next,
              what,
            });
    } catch (e) {
      return this.#lookupFailed(capKey, e);
    }
    if (r.ok) {
      recordCapLookupSuccess(capKey);
      if (this.#callId === null) this.#callId = (r.value as { callId: string }).callId;
      return null;
    }
    if (r.error.kind === "HandlerError" && r.error.refusal) {
      recordCapLookupSuccess(capKey);
      return operatorText(r.error.message);
    }
    return this.#lookupFailed(capKey, new Error(r.error.kind));
  }

  #lookupFailed(capKey: string, e: unknown): SpendRefusal | null {
    console.error("[chat-runner] AI spend ledger unreachable", {
      error: e instanceof Error ? e.message : String(e),
    });
    if (recordCapLookupFailure(capKey)) {
      return "The AI budget could not be checked several times in a row, so this chat stops here to protect the budget. Try again shortly; if it keeps happening, Settings → Costs shows the cause.";
    }
    // Let this request through; without a reservation the turn is recorded at its end.
    if (this.#callId === null) this.#unaccounted = true;
    return null;
  }

  /** What the turn's finished requests used: earlier runs plus this run's steps. */
  private used(steps: readonly ProviderStepSummary[]): Usage {
    const u = { ...this.#runStart };
    for (const s of steps) {
      if (!s.usage) continue;
      u.inputTokens += s.usage.inputTokens;
      u.outputTokens += s.usage.outputTokens;
      u.cachedTokens += s.usage.cachedTokens;
      u.cacheCreationTokens += s.usage.cacheCreationTokens;
      u.largestPromptTokens = Math.max(u.largestPromptTokens, s.usage.inputTokens);
    }
    return u;
  }

  /**
   * The turn ended: settle the row to the real totals. Returns what was
   * billed, or null when there is no row to settle (refused before its first
   * request, or unaccounted — the caller records the turn the old way).
   *
   * A request that went out without reporting usage, and whose failure does
   * not prove the provider billed nothing (an abort or a lost connection
   * while it ran), keeps its worst case: the row stays at least at its
   * reservation, overstated, never under.
   */
  async settle(
    usage: UsageAccumulator,
    durationMs: number,
    succeeded: boolean,
  ): Promise<{ aiCallId: string; costMicrocents: number } | null> {
    if (this.#callId === null) return null;
    const u = fromAccumulator(usage);
    const unreported = this.#sent - (usage.usageReports ?? 0) - (usage.unbilledFailures ?? 0);
    const r = await execute(this.deps.registry, this.deps.adapter, LEDGER_CTX, "ai_ledger.settle", {
      callId: this.#callId,
      ...this.target,
      usage: u,
      durationMs,
      succeeded,
      usageMissing: unreported > 0,
    }).catch((e: unknown) => ({ ok: false as const, error: { kind: String(e) } }));
    if (!r.ok) {
      // The row keeps its last reservation: overstated, never under.
      console.error("[chat-runner] the turn's AI spend was not settled", {
        error: "kind" in r.error ? r.error.kind : "unknown",
      });
      return null;
    }
    return {
      aiCallId: this.#callId,
      costMicrocents: (r.value as { costMicrocents: number }).costMicrocents,
    };
  }
}

function zero(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    largestPromptTokens: 0,
  };
}

function fromAccumulator(u: UsageAccumulator): Usage {
  return {
    inputTokens: u.totalIn,
    outputTokens: u.totalOut,
    cachedTokens: u.totalCached,
    cacheCreationTokens: u.totalCacheCreation ?? 0,
    largestPromptTokens: u.largestPromptTokens ?? 0,
  };
}

/** The ledger's refusal as the operator reads it in the chat (no op or code prefix). */
export function operatorText(message: string): string {
  return message.replace(/^ai_ledger\.\w+: /, "").replace(/^AiBudgetReached \([^)]*\): /, "");
}

/** The spender of a chat turn: the person it runs for, its chat, a subagent's parent chat. */
export function chatTurnSpender(
  actorId: string,
  chatSessionId: string,
  parentChatSessionId: string | null | undefined,
): AiSpender {
  return {
    kind: "actor",
    actorId,
    chatSessionId,
    ...(parentChatSessionId ? { parentChatSessionId } : {}),
  };
}
