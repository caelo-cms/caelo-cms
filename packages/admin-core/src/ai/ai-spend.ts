// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — one paid single-shot AI call inside the spend ledger: reserve the
 * worst case, run, settle to the real cost (or release when it threw before
 * the provider billed). The core helpers that call a model on their own —
 * moduleize, selector extraction (query_page_html), the turn-completeness
 * judge — run through this, so every budget sees them before they start.
 *
 * A refusal throws {@link AiSpendRefusedError} with the ledger's message.
 * A ledger that cannot be reached lets the call through once or twice and
 * records it after it ran (`chat.record_ai_call`, as before the ledger);
 * after LOOKUP_FAIL_THRESHOLD misses in a row it fails closed
 * (shared/cap-failures.ts).
 */

import type { AiSpender } from "@caelo-cms/plugin-host";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  recordCapLookupFailure,
  recordCapLookupSuccess,
} from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../audit.js";

const LEDGER_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "ai-spend",
};

/** The provider and model the call runs on. */
export interface AiSpendTarget {
  readonly provider: string;
  readonly model: string;
}

/** The request's bounds (plugin-host `promptTokenBound`, the output ceiling). */
export interface AiSpendRequest {
  readonly promptTokens: number;
  readonly maxOutputTokens: number;
}

/** What the finished call used. */
export interface AiSpendUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  readonly cacheCreationTokens?: number;
  /** The model it actually ran on, when the provider reports it. */
  readonly model?: string;
}

/** The ledger refused the call: a budget is reached (the message says which and what to do). */
export class AiSpendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiSpendRefusedError";
  }
}

/** Runs single-shot calls for one spender inside the ledger. */
export interface AiSpendRunner {
  run<T>(
    target: AiSpendTarget,
    request: AiSpendRequest,
    call: () => Promise<T>,
    usage: (result: T) => AiSpendUsage,
  ): Promise<T>;
}

/**
 * A runner for `spender`.
 *
 * @param opts.what names the call in a refusal ("module inference").
 * @param opts.record how an unreserved call is recorded (ledger unreachable):
 *   the context whose actor the row carries, and its chat attribution.
 */
export function aiSpendRunner(
  deps: { readonly registry: OperationRegistry; readonly adapter: DatabaseAdapter },
  spender: AiSpender,
  opts: {
    readonly what: string;
    readonly requestId?: string | null;
    readonly record: {
      readonly ctx: ExecutionContext;
      readonly chatSessionId: string | null;
      readonly parentChatSessionId?: string | null;
    };
  },
): AiSpendRunner {
  const capKey = `${spender.kind}:${spender.actorId}`;
  return {
    async run<T>(
      target: AiSpendTarget,
      request: AiSpendRequest,
      call: () => Promise<T>,
      usage: (result: T) => AiSpendUsage,
    ): Promise<T> {
      let callId: string | null = null;
      try {
        const r = await execute(deps.registry, deps.adapter, LEDGER_CTX, "ai_ledger.reserve", {
          spender,
          ...target,
          request,
          what: opts.what,
          // The column correlates logs; a longer id is cut, never a reason to fail.
          requestId: opts.requestId?.slice(0, 64) ?? null,
        });
        if (r.ok) {
          recordCapLookupSuccess(capKey);
          callId = (r.value as { callId: string }).callId;
        } else if (r.error.kind === "HandlerError" && r.error.refusal) {
          recordCapLookupSuccess(capKey);
          throw new AiSpendRefusedError(r.error.message);
        } else if (recordCapLookupFailure(capKey)) {
          throw new AiSpendRefusedError(lookupUnavailable(opts.what));
        }
      } catch (e) {
        if (e instanceof AiSpendRefusedError) throw e;
        if (recordCapLookupFailure(capKey))
          throw new AiSpendRefusedError(lookupUnavailable(opts.what));
      }
      const startedAt = Date.now();
      let result: T;
      try {
        result = await call();
      } catch (e) {
        if (callId) {
          await execute(deps.registry, deps.adapter, LEDGER_CTX, "ai_ledger.release", {
            callId,
          }).catch(() => undefined);
        }
        throw e;
      }
      const u = usage(result);
      const durationMs = Date.now() - startedAt;
      const model = u.model ?? target.model;
      if (callId) {
        const settled = await execute(deps.registry, deps.adapter, LEDGER_CTX, "ai_ledger.settle", {
          callId,
          provider: target.provider,
          model,
          usage: {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cachedTokens: u.cachedTokens ?? 0,
            cacheCreationTokens: u.cacheCreationTokens ?? 0,
          },
          durationMs,
          succeeded: true,
        }).catch((e: unknown) => ({ ok: false as const, error: e }));
        // The row keeps its reservation when the settle failed: overstated, never under.
        if (!settled.ok) console.error("[ai-spend] reservation not settled", { what: opts.what });
      } else {
        await execute(deps.registry, deps.adapter, opts.record.ctx, "chat.record_ai_call", {
          chatSessionId: opts.record.chatSessionId,
          ...(opts.record.parentChatSessionId !== undefined
            ? { parentChatSessionId: opts.record.parentChatSessionId }
            : {}),
          provider: target.provider,
          model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cachedTokens: u.cachedTokens ?? 0,
          cacheCreationTokens: u.cacheCreationTokens ?? 0,
          durationMs,
        }).catch((e: unknown) => {
          console.error("[ai-spend] ai_calls row not recorded — spend is understated", {
            what: opts.what,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      return result;
    },
  };
}

function lookupUnavailable(what: string): string {
  return `AiBudgetUnavailable: the AI budget could not be checked several times in a row, so ${what} does not run (failing closed to protect the budget). Try again shortly; Settings → Costs shows the cause.`;
}
