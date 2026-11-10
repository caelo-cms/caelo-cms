// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — how a request asks for a build it may not live to see end:
 * an agent's Stage (it waits about a minute), a button's Stage, Publish
 * live or production build (the browser tab may close mid-build). The
 * request writes a build order, starts the order's carrier and waits for
 * the outcome as long as it waits; the build itself runs inside the
 * carrier's request (run-order.ts), on whichever admin instance takes it.
 *
 *   gcp, gcp-firebase  the carrier is one execution of the build carrier's
 *                      Cloud Run job (kind.ts): request-billed CPU is there
 *                      while its request is
 *   self-hosted, dev   the same carrier inside the admin's process (the
 *                      admin has CPU between requests there); a process
 *                      that registered no launcher (a test, a script) runs
 *                      it in-process too — a build must run when asked
 *   aws, azure         nowhere yet (#749, #750): the order fails at once
 *
 * The Live Edit chat's own Stage is not carried: it waits inside its turn,
 * and the operator's Stop or a closed tab stops it with the turn (#1204).
 * The tick's plugin-data build runs inside the tick.
 */

import { randomUUID } from "node:crypto";
import { execute, type QueryError } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok, type Result } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { StagedBy } from "../quality/chat-feedback.js";
import { inProcessJobLauncher } from "../reporting-jobs/in-process.js";
import { type AdminJobDeps, REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";
import {
  giveUpReportingJob,
  type JobLauncher,
  launcherFor,
  startReportingJob,
} from "../reporting-jobs/launcher.js";
import { ADMIN_REQUEST_LIMIT_SECONDS } from "../reporting-jobs/protocol.js";
import type { StagedChats, StageFailure } from "../stage/stage-chats.js";
import { buildCarrierJobKind } from "./kind.js";
import { actorOf, type BuildOpName, type BuildOrder, type BuildOutcome } from "./order.js";

/**
 * How long before the admin's request limit a carried build stops (so its
 * failure is recorded before Cloud Run cuts the request off).
 */
const LIMIT_MARGIN_SECONDS = 2 * 60;

/** How a carried build's caller waits. */
export interface CarryOptions {
  /** The order's id — the run's id for a Stage, a build or a Publish live. Minted when absent. */
  readonly id?: string;
  /** How long the caller waits for the outcome; absent: until the build ends. */
  readonly waitMs?: number;
  /** The caller's Stop (the operator's): passed on to the build while the caller waits. */
  readonly signal?: AbortSignal;
  /** The most seconds the build may run; default: the admin's request limit where one holds. */
  readonly maxRunSeconds?: number | null;
  /** Where the carrier runs instead of this install's choice (tests). */
  readonly launcher?: JobLauncher;
}

/** A carried build's outcome, or "still running" once the caller's wait is over. */
export type Carried =
  | { readonly state: "done"; readonly outcome: BuildOutcome }
  | { readonly state: "running"; readonly id: string };

/** The most a carried build may run on this install (null: no request limit). */
export function carriedBuildLimitSeconds(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const provider = env.CAELO_PROVIDER ?? "";
  return provider === "gcp" || provider === "gcp-firebase"
    ? ADMIN_REQUEST_LIMIT_SECONDS - LIMIT_MARGIN_SECONDS
    : null;
}

function systemCtx(ctx: ExecutionContext): ExecutionContext {
  return { ...REPORTING_JOB_CTX, requestId: ctx.requestId };
}

function failed(kind: BuildOrder["kind"], message: string): Carried {
  return {
    state: "done",
    outcome: { ok: false, error: { kind: "HandlerError", operation: kind, message } },
  };
}

/**
 * Order `order` as `ctx`, start its carrier, and wait for the outcome as
 * `opts` says (see the file comment).
 */
export async function carryBuild(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  order: BuildOrder,
  opts: CarryOptions = {},
): Promise<Carried> {
  const { registry, adapter } = deps;
  const sys = systemCtx(ctx);
  const id = opts.id ?? randomUUID();
  const created = await execute(registry, adapter, sys, "build_orders.create", {
    id,
    kind: order.kind,
    input: order.input,
    actor: actorOf(ctx),
    maxRunSeconds:
      opts.maxRunSeconds !== undefined ? opts.maxRunSeconds : carriedBuildLimitSeconds(),
  });
  if (!created.ok) {
    return failed(order.kind, `the build could not be ordered: ${describeError(created.error)}`);
  }
  // Nothing in this process registered a launcher (a test, a script): the
  // carrier runs here, as on a self-hosted admin.
  const launcher =
    opts.launcher ??
    (launcherFor(buildCarrierJobKind).kind === "none"
      ? inProcessJobLauncher(deps, "build")
      : undefined);
  const started = await startReportingJob(deps, "build", id, launcher ? { launcher } : {});
  if (started.outcome === "launch-failed") {
    // Never retried later: the person who asked is told now (kind.ts).
    await giveUpReportingJob(deps, buildCarrierJobKind, id, `its carrier job ${started.message}`);
  }
  return waitForOrder(deps, sys, id, order.kind, opts);
}

/** Wait for order `id` as `opts` says; poll the order with a short back-off. */
async function waitForOrder(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  id: string,
  kind: BuildOrder["kind"],
  opts: CarryOptions,
): Promise<Carried> {
  const { registry, adapter } = deps;
  const until = opts.waitMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.waitMs;
  let stopPassedOn = false;
  let pause = 100;
  for (;;) {
    const r = await execute(registry, adapter, sys, "build_orders.get", { id });
    if (!r.ok)
      return failed(kind, `the build's order could not be read: ${describeError(r.error)}`);
    const found = (r.value as { order: { state: string; outcome: BuildOutcome | null } | null })
      .order;
    if (!found) return failed(kind, "the build's order is gone");
    if (found.state === "done" && found.outcome) return { state: "done", outcome: found.outcome };
    if (opts.signal?.aborted && !stopPassedOn) {
      stopPassedOn = true;
      const stopped = await execute(registry, adapter, sys, "build_orders.request_stop", { id });
      if (!stopped.ok) {
        console.error("[build-carrier] could not pass the Stop on", {
          id,
          error: describeError(stopped.error),
        });
      }
      continue;
    }
    const left = until - Date.now();
    if (left <= 0) return { state: "running", id };
    await pauseFor(Math.min(pause, left), stopPassedOn ? undefined : opts.signal);
    pause = Math.min(pause * 2, 2_000);
  }
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function pauseFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A stored error as the QueryError it was (or the given-up message as one). */
function asQueryError(error: unknown, operation: string): QueryError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "string"
  ) {
    return error as QueryError;
  }
  return { kind: "HandlerError", operation, message: String(error) };
}

/**
 * Run `op` with `input` as a carried build and wait until it ends: the same
 * answer `execute` gives in the caller's request. The order's id becomes
 * the run's id where the op takes one.
 */
export async function executeBuild(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  op: BuildOpName,
  input: Readonly<Record<string, unknown>>,
  opts: Omit<CarryOptions, "waitMs"> = {},
): Promise<Result<unknown, QueryError>> {
  const carried = await carryBuild(deps, ctx, { kind: op, input }, opts);
  if (carried.state !== "done") {
    throw new Error("executeBuild waits until its build ends; the order is still running");
  }
  return carried.outcome.ok
    ? ok(carried.outcome.value)
    : err(asQueryError(carried.outcome.error, op));
}

/** The Stage flow's answer (stage-chats.ts `stageChatSessions`). */
export type StageAnswer = { ok: true; value: StagedChats } | { ok: false; error: StageFailure };

/** A carried build the caller stopped waiting for. */
export type StillRunning = { readonly state: "running"; readonly id: string };

type StageOptions = CarryOptions & { readonly stagedBy?: StagedBy };

/**
 * The Stage of `chatSessionIds` as a carried build: stageChatSessions'
 * answer, or — with `opts.waitMs` — "still running" once the wait is over.
 */
export async function carryStage(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  chatSessionIds: readonly string[],
  opts: StageOptions & { readonly waitMs: number },
): Promise<StageAnswer | StillRunning>;
export async function carryStage(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  chatSessionIds: readonly string[],
  opts?: Omit<StageOptions, "waitMs">,
): Promise<StageAnswer>;
export async function carryStage(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  chatSessionIds: readonly string[],
  opts: StageOptions = {},
): Promise<StageAnswer | StillRunning> {
  const carried = await carryBuild(
    deps,
    ctx,
    {
      kind: "stage",
      input: {
        chatSessionIds: [...new Set(chatSessionIds)],
        stagedBy: opts.stagedBy ?? "operator",
      },
    },
    opts,
  );
  if (carried.state === "running") return carried;
  const { outcome } = carried;
  if (outcome.ok) return { ok: true, value: outcome.value as StagedChats };
  // The Stage flow's own failure, or the carrier's (given up, never started).
  const failure = outcome.error as Partial<StageFailure>;
  if (typeof failure.step === "string" && failure.error) {
    return { ok: false, error: failure as StageFailure };
  }
  const error = asQueryError(outcome.error, "stage");
  return {
    ok: false,
    error: {
      step: "deploy",
      chatSessionId: null,
      message: `Staging build failed: ${describeError(error)}`,
      error,
    },
  };
}
