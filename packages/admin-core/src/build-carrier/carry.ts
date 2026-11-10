// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — how a request asks for a build it may not live to see end:
 * an agent's Stage (it waits about a minute), a button's Stage, Publish
 * live or production build (the browser tab may close mid-build). The
 * request checks what the op would refuse at once (preflight.ts), writes a
 * build order, starts the order's carrier and waits for the outcome as long
 * as it waits; the build itself runs inside the carrier's request
 * (run-order.ts), on whichever admin instance takes it.
 *
 *   gcp, gcp-firebase  the carrier is one execution of the build carrier's
 *                      Cloud Run job (kind.ts): request-billed CPU is there
 *                      while its request is
 *   self-hosted, dev   the same carrier inside the admin's process (the
 *                      admin has CPU between requests there); a process
 *                      that registered no launcher (a test, a script) runs
 *                      it in-process too — a build must run when asked
 *   no carrier         (a Google Cloud admin whose converge step did not set
 *                      it up, AWS / Azure #749 / #750): a button builds in
 *                      its own request, as before the carrier, and says so;
 *                      an agent is refused with the step to re-run
 *
 * The Live Edit chat's own Stage is not carried: it waits inside its turn,
 * and the operator's Stop or a closed tab stops it with the turn (#1204).
 * The tick's plugin-data build runs inside the tick.
 */

import { randomUUID } from "node:crypto";
import { execute, type QueryError } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok, type Result } from "@caelo-cms/shared";
import { stoppedByOperator } from "../ai/chat-runner/agent-runs.js";
import { describeError } from "../ai/tools/_describe-error.js";
import { abortableSleep } from "../ops/deploy-lease-steps.js";
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
import { BUILD_CARRIER_JOB_ENV_VAR, buildCarrierJobKind } from "./kind.js";
import { actorOf, type BuildOpName, type BuildOrder, type BuildOutcome } from "./order.js";
import { preflightBuild } from "./preflight.js";
import { executeBuildOrder } from "./run-order.js";

/**
 * How long before the admin's request limit a carried build stops (so its
 * failure is recorded before Cloud Run cuts the request off).
 */
const LIMIT_MARGIN_SECONDS = 2 * 60;

/** The waiting request's look at its order: from this pause, doubling, up to the next. */
const FIRST_LOOK_MS = 250;
const LONGEST_LOOK_MS = 5_000;

/** A signal that never aborts (a wait nobody can stop). */
const NEVER = new AbortController().signal;

/** How a carried build's caller waits. */
export interface CarryOptions {
  /** The order's id — the run's id of every carried build. Minted when absent. */
  readonly id?: string;
  /**
   * How long the caller waits, counted from the call — checking, ordering
   * and starting the carrier included; absent: until the build ends.
   */
  readonly waitMs?: number;
  /**
   * The operator's Stop: passed on to the build while the caller waits, its
   * reason recorded. Only a Stop (see {@link operatorStopOf}): a caller whose
   * request merely ended leaves the build to its carrier.
   */
  readonly stopSignal?: AbortSignal;
  /** The most seconds the build may run; default: the admin's request limit where one holds. */
  readonly maxRunSeconds?: number | null;
  /** Where the carrier runs instead of this install's choice (tests). */
  readonly launcher?: JobLauncher;
  /** Treat this install as one without a carrier, for this reason (tests). */
  readonly unavailable?: string;
}

/**
 * A carried build's outcome, or "still running" once the caller's wait is
 * over. `warning`: the build ran without its carrier (see the file comment).
 */
export type Carried =
  | { readonly state: "done"; readonly outcome: BuildOutcome; readonly warning?: string }
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

/**
 * The part of a caller's abort signal that is the operator's Stop. A
 * request that merely ended (a client that gave up waiting) must not stop
 * a build the carrier exists to keep going.
 */
export function operatorStopOf(signal: AbortSignal): AbortSignal {
  const stop = new AbortController();
  const onAbort = (): void => {
    if (stoppedByOperator(signal)) stop.abort(signal.reason);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return stop.signal;
}

/** What a stop says on the stopped run: the operator's Stop, or the reason given. */
function stopReasonOf(reason: unknown): string {
  if (reason instanceof Error && reason.name === "OperatorStoppedError") {
    return "the operator stopped it";
  }
  const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return (text || "the operator stopped it").slice(0, 500);
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
  // The caller's budget starts now: an agent's MCP call has about a minute
  // in all, the checks, the order and the carrier's start included.
  const until = opts.waitMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.waitMs;
  const refused = await preflightBuild(deps, ctx, order);
  if (refused) return { state: "done", outcome: refused };
  if (opts.unavailable !== undefined) {
    return withoutCarrier(deps, ctx, order, opts, opts.unavailable);
  }
  const choice = opts.launcher ? null : launcherFor(buildCarrierJobKind);
  if (choice?.kind === "unavailable") {
    return withoutCarrier(deps, ctx, order, opts, whyNoCarrier(choice.message));
  }

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
    opts.launcher ?? (choice?.kind === "none" ? inProcessJobLauncher(deps, "build") : undefined);
  const starting = startCarrier(deps, id, launcher);
  if (!(await settlesBefore(starting, until, id))) {
    // The caller's wait ran out while the job was being started (a stalled
    // launch): it hears "still running" with the order's id. The order
    // stays one that settles without this request: a launch that fails
    // gives it up, a late carrier runs it, and the backstop gives up one
    // whose job never reports.
    return { state: "running", id };
  }
  return waitForOrder(deps, sys, id, order.kind, until, opts.stopSignal);
}

/** Start order `id`'s carrier; a launch that fails gives the order up at once. */
async function startCarrier(
  deps: AdminJobDeps,
  id: string,
  launcher: JobLauncher | undefined,
): Promise<void> {
  const started = await startReportingJob(deps, "build", id, launcher ? { launcher } : {});
  if (started.outcome === "launch-failed") {
    // Never retried later: the person who asked is told now (kind.ts).
    await giveUpReportingJob(deps, buildCarrierJobKind, id, `its carrier job ${started.message}`);
  }
}

/**
 * Whether `work` settles before `until` (its failure is thrown, as when it
 * is awaited). Past `until` nobody waits for it, so a later failure is
 * logged instead.
 */
async function settlesBefore(work: Promise<void>, until: number, id: string): Promise<boolean> {
  if (until === Number.POSITIVE_INFINITY) {
    await work;
    return true;
  }
  const timer = new AbortController();
  const inTime = await Promise.race([
    work.then(() => true),
    abortableSleep(Math.max(0, until - Date.now()), timer.signal).then(() => false),
  ]).finally(() => timer.abort());
  if (!inTime) {
    work.catch((e: unknown) => {
      console.error("[build-carrier] the carrier's start failed after its caller stopped waiting", {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }
  return inTime;
}

/**
 * Why this install has no build carrier. The launcher's own message speaks
 * of work recorded as failed, never run in the admin (true of the audit and
 * the crawl); a build without its carrier is told differently (below).
 */
function whyNoCarrier(
  launcherMessage: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const provider = env.CAELO_PROVIDER ?? "";
  if (provider === "aws" || provider === "azure") {
    return `provider "${provider}" has no build carrier yet (${buildCarrierJobKind.pendingIssue[provider]})`;
  }
  const gcp = provider === "gcp" || provider === "gcp-firebase";
  if (gcp && !(env[BUILD_CARRIER_JOB_ENV_VAR]?.trim() && env.CAELO_ADMIN_URL?.trim())) {
    return `the admin has no build carrier job (${BUILD_CARRIER_JOB_ENV_VAR} or CAELO_ADMIN_URL is not set)`;
  }
  return launcherMessage;
}

/**
 * No carrier on this install (see the file comment): a person waiting in
 * this request gets the build in it, with a warning; an agent, whose call
 * ends within a minute, is refused with what to set up.
 */
async function withoutCarrier(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  order: BuildOrder,
  opts: CarryOptions,
  why: string,
): Promise<Carried> {
  const gcp = carriedBuildLimitSeconds() !== null;
  const setUp = gcp
    ? ' Re-run the upgrade (`cms-provision upgrade`, its step "Ensuring the build carrier") to set the carrier up.'
    : "";
  if (opts.waitMs !== undefined) {
    return failed(
      order.kind,
      `Nothing was built: ${why}. Without a build carrier the build would stop when this call ends.${setUp} A Stage or Publish live from the editor still works meanwhile.`,
    );
  }
  console.error("[build-carrier] no build carrier: building inside the caller's request", {
    kind: order.kind,
    why,
  });
  const outcome = await executeBuildOrder(
    deps,
    ctx,
    opts.id ?? randomUUID(),
    order,
    opts.stopSignal ?? NEVER,
  );
  return {
    state: "done",
    outcome: JSON.parse(JSON.stringify(outcome)) as BuildOutcome,
    warning: `This build ran inside your request, not in a build carrier (${why}): closing the tab mid-build could have stopped it.${setUp}`,
  };
}

/** Wait for order `id` until `until`; look at it with a back-off. */
async function waitForOrder(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  id: string,
  kind: BuildOrder["kind"],
  until: number,
  stopSignal: AbortSignal | undefined,
): Promise<Carried> {
  const { registry, adapter } = deps;
  let stopPassedOn = false;
  let pause = FIRST_LOOK_MS;
  for (;;) {
    const r = await execute(registry, adapter, sys, "build_orders.get", { id });
    if (!r.ok)
      return failed(kind, `the build's order could not be read: ${describeError(r.error)}`);
    const found = (r.value as { order: { state: string; outcome: BuildOutcome | null } | null })
      .order;
    if (!found) return failed(kind, "the build's order is gone");
    // Final: an order ends once, with what its build can no longer change.
    if (found.state === "done" && found.outcome) return { state: "done", outcome: found.outcome };
    if (stopSignal?.aborted && !stopPassedOn) {
      stopPassedOn = true;
      const stopped = await execute(registry, adapter, sys, "build_orders.request_stop", {
        id,
        reason: stopReasonOf(stopSignal.reason),
      });
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
    await abortableSleep(Math.min(pause, left), stopPassedOn ? NEVER : (stopSignal ?? NEVER));
    pause = Math.min(pause * 2, LONGEST_LOOK_MS);
  }
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

/** Whether a success was read back from the run (its result was never recorded). */
function recovered(value: unknown): { runId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { recovered?: unknown; runId?: unknown };
  return v.recovered === true && typeof v.runId === "string" ? { runId: v.runId } : null;
}

/** `executeBuild`'s answer: `execute`'s, plus the warning of a build run without its carrier. */
export type BuildResult = Result<unknown, QueryError> & { readonly warning?: string };

/**
 * Run `op` with `input` as a carried build and wait until it ends: the same
 * answer `execute` gives in the caller's request. The order's id becomes
 * the run's id.
 */
export async function executeBuild(
  deps: AdminJobDeps,
  ctx: ExecutionContext,
  op: BuildOpName,
  input: Readonly<Record<string, unknown>>,
  opts: Omit<CarryOptions, "waitMs"> = {},
): Promise<BuildResult> {
  const carried = await carryBuild(deps, ctx, { kind: op, input }, opts);
  if (carried.state !== "done") {
    throw new Error("executeBuild waits until its build ends; the order is still running");
  }
  const warning = carried.warning ? { warning: carried.warning } : {};
  const { outcome } = carried;
  if (!outcome.ok) return { ...err(asQueryError(outcome.error, op)), ...warning };
  const lost = recovered(outcome.value);
  if (lost) {
    // It went through, but its answer is gone: say so, and that it must
    // not be repeated.
    return {
      ...err({
        kind: "HandlerError",
        operation: op,
        message: `The build went through (run ${lost.runId}), but its carrier stopped before the result was recorded, so its details are not shown here. Do not run it again: Settings → Deployments shows the run.`,
      }),
      ...warning,
    };
  }
  return { ...ok(outcome.value), ...warning };
}

/** The Stage flow's answer (stage-chats.ts `stageChatSessions`). */
export type StageAnswer = (
  | { ok: true; value: StagedChats }
  | { ok: false; error: StageFailure }
) & { readonly warning?: string };

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
  const warning = carried.warning ? { warning: carried.warning } : {};
  const { outcome } = carried;
  const lost = outcome.ok ? recovered(outcome.value) : null;
  if (outcome.ok && !lost) return { ok: true, value: outcome.value as StagedChats, ...warning };
  if (lost) {
    const error: QueryError = {
      kind: "HandlerError",
      operation: "stage",
      message: `Staging was rebuilt (run ${lost.runId}), but its carrier stopped before the Stage's result was recorded. Do not Stage again for it: the quality check follows as usual.`,
    };
    return {
      ok: false,
      error: { step: "deploy", chatSessionId: null, message: error.message, error },
      ...warning,
    };
  }
  // The Stage flow's own failure, or the carrier's (given up, never started).
  const failure = (outcome as { error: unknown }).error as Partial<StageFailure>;
  if (typeof failure.step === "string" && failure.error) {
    return { ok: false, error: failure as StageFailure, ...warning };
  }
  const error = asQueryError((outcome as { error: unknown }).error, "stage");
  return {
    ok: false,
    error: {
      step: "deploy",
      chatSessionId: null,
      message: `Staging build failed: ${describeError(error)}`,
      error,
    },
    ...warning,
  };
}
