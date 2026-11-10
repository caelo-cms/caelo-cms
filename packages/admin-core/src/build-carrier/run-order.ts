// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — the admin's side of a build carrier's one report, `run`:
 * take the order, run its build inside this request, record how it ended,
 * answer. The request is what gives the admin the CPU for the build on a
 * request-billed instance (CLAUDE.md §11.B Tier 5), so the build stops
 * when the request can no longer carry it:
 *
 *   - the carrier's request ended first (the job died, its connection
 *     dropped): nothing carries the build any more;
 *   - the order's run time is up: past the admin's request limit Cloud Run
 *     would cut the request off mid-build, so the build stops before that,
 *     loudly, with the reason;
 *   - the operator asked it to stop (the request that asked for the build
 *     passes the Stop on through the order).
 *
 * A stopped build ends as its op ends on an abort: the generator is
 * killed, nothing more is published, the run is recorded as failed with
 * the reason (deploy-trigger.ts, deploy-promote.ts). Publishing itself
 * stays the op's own step, so a stop never leaves a build half-published.
 */

import { execute, type QueryError } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import {
  ActionRefusal,
  type ActionRequest,
  type ActionResult,
  type AdminJobDeps,
  REPORTING_JOB_CTX,
} from "../reporting-jobs/kind.js";
import { ADMIN_REQUEST_LIMIT_SECONDS } from "../reporting-jobs/protocol.js";
import { stageChatSessions } from "../stage/stage-chats.js";
import {
  type BuildOrder,
  type BuildOrderKind,
  type BuildOutcome,
  type BuildRunAnswer,
  contextOf,
  type OrderActor,
  stageOrderInputSchema,
} from "./order.js";
import { watchForStop } from "./stop-watch.js";

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

interface ClaimedOrder {
  readonly kind: BuildOrderKind;
  readonly input: Record<string, unknown>;
  readonly actor: OrderActor;
  readonly maxRunSeconds: number | null;
  /** Set when the order was asked to stop before its carrier took it. */
  readonly stopReason: string | null;
  /** How long the order waited for its carrier (the job's start). */
  readonly waitedMs: number;
}

/**
 * How the order's outcome is recorded: a short op, tried again a few times
 * while this request still carries it — once the request ends, the outcome
 * would be lost and the backstop could only read it back from the run.
 */
const FINISH_TRIES = [0, 1_000, 3_000, 7_000] as const;

async function recordOutcome(
  deps: AdminJobDeps,
  orderId: string,
  outcome: BuildOutcome,
): Promise<void> {
  let last: unknown = null;
  for (const wait of FINISH_TRIES) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await op(deps, "build_orders.finish", { id: orderId, outcome });
      return;
    } catch (e) {
      last = e;
      console.error(`[build-carrier] ${orderId}: could not record the outcome yet:`, describe(e));
    }
  }
  throw last;
}

function answer(outcome: BuildOutcome): ActionResult {
  return {
    value: { outcome: outcome.ok ? "succeeded" : "failed" } satisfies BuildRunAnswer,
    done: { outcome: "completed" },
  };
}

/**
 * The `run` report: run order `orderId`'s build inside this request (see
 * the file comment).
 *
 * @throws ActionRefusal when an earlier request of this carrier runs the
 *   build already: this report ends, that one records the outcome.
 */
export async function runBuildOrder(
  deps: AdminJobDeps,
  orderId: string,
  request: ActionRequest,
): Promise<ActionResult> {
  const claimed = await op<{
    state: "claimed" | "running" | "done" | "missing";
    order: ClaimedOrder | null;
    outcome: BuildOutcome | null;
  }>(deps, "build_orders.claim", { id: orderId });
  if (claimed.state === "missing") {
    return {
      value: { outcome: "missing" } satisfies BuildRunAnswer,
      done: { outcome: "stopped", note: "the build order is gone" },
    };
  }
  if (claimed.state === "done") {
    return answer(claimed.outcome ?? { ok: false, error: "no outcome recorded" });
  }
  if (claimed.state === "running" || !claimed.order) {
    throw new ActionRefusal(
      "the build already runs in an earlier request of this carrier; this report ends and that request records how the build ends",
    );
  }
  const order = claimed.order;
  // The carrier job's start as a person waits for it: a cold start counts.
  console.info(
    `[build-carrier] ${orderId}: its carrier took the ${order.kind} order ${order.waitedMs} ms after it was written`,
  );
  let outcome: BuildOutcome;
  if (order.stopReason !== null) {
    outcome = stoppedBeforeStart(order.kind, order.stopReason);
  } else {
    outcome = await withLimits(deps, orderId, order, request.signal, (signal) =>
      executeBuildOrder(
        deps,
        contextOf(order.actor),
        orderId,
        { kind: order.kind, input: order.input } as BuildOrder,
        signal,
      ),
    );
  }
  await recordOutcome(deps, orderId, plain(outcome));
  return answer(outcome);
}

function stoppedBeforeStart(kind: BuildOrderKind, reason: string): BuildOutcome {
  return {
    ok: false,
    error: {
      kind: "HandlerError",
      operation: kind,
      message: `The build was stopped before it started (${reason}); nothing was built or published. Start it again when ready.`,
    },
  };
}

/** An outcome as the order stores it: plain JSON. */
function plain(outcome: BuildOutcome): BuildOutcome {
  return JSON.parse(JSON.stringify(outcome)) as BuildOutcome;
}

/**
 * Run `work` under the three stops of the file comment; the signal it gets
 * aborts with the reason the build's failure then names.
 */
async function withLimits(
  deps: AdminJobDeps,
  orderId: string,
  order: ClaimedOrder,
  requestSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<BuildOutcome>,
): Promise<BuildOutcome> {
  const stop = new AbortController();
  const carrierGone = (): void =>
    stop.abort(
      new Error(
        "its build carrier job stopped: the request that carried the build ended before the build did",
      ),
    );
  if (requestSignal?.aborted) carrierGone();
  requestSignal?.addEventListener("abort", carrierGone, { once: true });
  const limit =
    order.maxRunSeconds === null
      ? undefined
      : setTimeout(
          () =>
            stop.abort(
              new Error(
                `it ran ${formatSeconds(order.maxRunSeconds ?? 0)}, the longest a build may run here: the admin's requests end after ${formatSeconds(ADMIN_REQUEST_LIMIT_SECONDS)} (Cloud Run's request limit), and a build cut off there would end half-way`,
              ),
            ),
          order.maxRunSeconds * 1000,
        );
  const endWatch = watchForStop(deps, orderId, stop);
  try {
    return await work(stop.signal);
  } catch (e) {
    // A throw past the build's own failure handling is a bug; the order
    // still ends failed instead of waiting for the backstop.
    console.error(`[build-carrier] ${orderId}: the build threw:`, describe(e));
    return {
      ok: false,
      error: {
        kind: "HandlerError",
        operation: order.kind,
        message: `the build stopped on an unexpected error: ${describe(e)}`,
      },
    };
  } finally {
    clearTimeout(limit);
    endWatch();
    requestSignal?.removeEventListener("abort", carrierGone);
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatSeconds(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} s`;
}

function asOutcome(
  r: { ok: true; value: unknown } | { ok: false; error: QueryError },
): BuildOutcome {
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

/**
 * Run one order's build under `ctx` — the caller's context as the order
 * stored it, so the build's own checks (a human for production, the
 * caller's permissions) decide as they would have in the caller's request.
 * The order's id is the run's id where the op takes one.
 */
export async function executeBuildOrder(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  orderId: string,
  order: BuildOrder,
  signal: AbortSignal,
): Promise<BuildOutcome> {
  const { registry, adapter } = deps;
  switch (order.kind) {
    case "stage": {
      const input = stageOrderInputSchema.parse(order.input);
      const staged = await stageChatSessions(deps, ctx, input.chatSessionIds, {
        stagedBy: input.stagedBy,
        deployRunId: orderId,
        abortSignal: signal,
      });
      return staged.ok ? { ok: true, value: staged.value } : { ok: false, error: staged.error };
    }
    case "deploy.trigger":
      return asOutcome(
        await execute(
          registry,
          adapter,
          ctx,
          "deploy.trigger",
          { ...order.input, runId: orderId },
          { signal },
        ),
      );
    case "deploy.promote":
      return asOutcome(
        await execute(
          registry,
          adapter,
          ctx,
          "deploy.promote",
          { ...order.input, runId: orderId },
          { signal },
        ),
      );
    case "deploy.execute_proposal":
      // Its claim takes the order's id as its run's, like every carried build.
      return asOutcome(
        await execute(
          registry,
          adapter,
          ctx,
          "deploy.execute_proposal",
          { ...order.input, runId: orderId },
          { signal },
        ),
      );
    case "quality_audits.publish_anyway":
      return asOutcome(
        await execute(
          registry,
          adapter,
          ctx,
          "quality_audits.publish_anyway",
          { ...order.input, runId: orderId },
          { signal },
        ),
      );
    case "quality_audits.execute_proposal":
      // An approved publish-anyway; its claim takes the order's id as its run's.
      return asOutcome(
        await execute(
          registry,
          adapter,
          ctx,
          "quality_audits.execute_proposal",
          { ...order.input, runId: orderId },
          { signal },
        ),
      );
  }
}
