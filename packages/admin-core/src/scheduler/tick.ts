// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — one scheduler tick: run every task that is due.
 *
 * The admin only does work inside a request. The scheduler (Cloud Scheduler
 * on Google Cloud, a compose service on self-hosted) calls
 * `POST /api/internal/scheduler/tick` every few minutes, and that request
 * runs {@link runSchedulerTick}, holding the request open until the work is
 * done, so the work runs on the CPU the request is billed for.
 *
 * For each task, in the order given: claim it in the due-table
 * (`scheduled_tasks.claim`, which succeeds only when it is due and nobody
 * holds it), run it, record the outcome and its next due time
 * (`scheduled_tasks.finish`). Claiming right before running means a task
 * the tick never reaches stays due for the next one, and concurrent ticks
 * on several instances run each task once.
 *
 * Bounds:
 *   - the tick stops claiming once its time budget is spent; the rest wait
 *     for the next tick (the order puts the cheap, frequent tasks first);
 *   - the tick stops waiting for a run after the task's lease. Such a run
 *     keeps its lease until it expires, so no other tick starts it again
 *     meanwhile; its outcome is only in the logs.
 *
 * A task that throws is recorded as failed and retried at its next due
 * time; it never stops the tick. A failing due-table op does: that is the
 * database, and the scheduler's next call retries.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import {
  NO_OCCURRENCE_RECHECK_SECONDS,
  type ScheduledTask,
  TASK_DUE_SLACK_SECONDS,
} from "./task.js";

/** How long one tick keeps claiming tasks. Below every scheduler's request timeout. */
export const TICK_BUDGET_MS = 4 * 60 * 1000;

/** What happened to one task in a tick. */
export interface TaskRunReport {
  readonly key: string;
  readonly outcome: "ok" | "failed" | "timed_out";
  readonly durationMs: number;
  /** The task's summary, or why it failed. */
  readonly detail: string | null;
}

/** What one tick did. */
export interface SchedulerTickReport {
  readonly holder: string;
  readonly ran: readonly TaskRunReport[];
  /** Tasks that were not due (or another tick holds them). */
  readonly notDue: number;
  /** Tasks the tick did not reach within its budget; due again next tick. */
  readonly deferred: readonly string[];
}

export interface SchedulerTickDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly tasks: readonly ScheduledTask[];
  /** Names this tick in the leases (instance + request). */
  readonly holder: string;
  readonly budgetMs?: number;
  /** Milliseconds since the epoch; tests pin it. */
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

let n = 0;
const ctx = (holder: string): ExecutionContext => ({
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: `scheduler-tick-${holder}-${n++}`,
});

async function call<T>(deps: SchedulerTickDeps, op: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, ctx(deps.holder), op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

const TIMED_OUT = Symbol("timed out");

/** Run `task` but stop waiting after its lease. */
async function runBounded(task: ScheduledTask): Promise<string | undefined | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), task.leaseSeconds * 1000);
  });
  try {
    return await Promise.race([task.run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** When the task is due next, as `scheduled_tasks.finish` takes it. */
function nextDue(
  task: ScheduledTask,
  finishedAt: number,
): { afterSeconds: number | null; at: string | null } {
  if ("everySeconds" in task.cadence) {
    return {
      afterSeconds: Math.max(0, task.cadence.everySeconds - TASK_DUE_SLACK_SECONDS),
      at: null,
    };
  }
  const next = task.cadence.nextAfter(new Date(finishedAt));
  return {
    afterSeconds: null,
    at: (next ?? new Date(finishedAt + NO_OCCURRENCE_RECHECK_SECONDS * 1000)).toISOString(),
  };
}

/**
 * Run one tick over `deps.tasks`.
 *
 * @throws when a due-table op fails (the database); task failures are
 *   reported, never thrown.
 */
export async function runSchedulerTick(deps: SchedulerTickDeps): Promise<SchedulerTickReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const budget = deps.budgetMs ?? TICK_BUDGET_MS;
  const started = now();
  const ran: TaskRunReport[] = [];
  const deferred: string[] = [];
  let notDue = 0;

  for (const task of deps.tasks) {
    if (now() - started >= budget) {
      deferred.push(task.key);
      continue;
    }
    const { claimed } = await call<{ claimed: boolean }>(deps, "scheduled_tasks.claim", {
      taskKey: task.key,
      holder: deps.holder,
      leaseSeconds: task.leaseSeconds,
    });
    if (!claimed) {
      notDue += 1;
      continue;
    }
    const t0 = now();
    let outcome: TaskRunReport["outcome"];
    let detail: string | null;
    try {
      const result = await runBounded(task);
      if (result === TIMED_OUT) {
        outcome = "timed_out";
        detail = `still running after its ${task.leaseSeconds} s lease; it keeps the lease until it expires`;
      } else {
        outcome = "ok";
        detail = result ?? null;
      }
    } catch (e) {
      outcome = "failed";
      detail = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    }
    const durationMs = Math.max(0, now() - t0);
    ran.push({ key: task.key, outcome, durationMs, detail });
    if (outcome === "failed") log(`[scheduler] ${task.key} failed: ${detail}`);
    if (outcome === "timed_out") {
      log(`[scheduler] ${task.key} ${detail}`);
      continue;
    }
    const finish = await execute(
      deps.registry,
      deps.adapter,
      ctx(deps.holder),
      "scheduled_tasks.finish",
      {
        taskKey: task.key,
        holder: deps.holder,
        outcome,
        error: outcome === "failed" ? detail : null,
        durationMs,
        ...nextDue(task, now()),
      },
    );
    // Lost lease: another tick took over after this run outlived it. Its
    // record stands; this one is logged.
    if (!finish.ok) log(`[scheduler] ${task.key}: ${JSON.stringify(finish.error)}`);
  }
  return { holder: deps.holder, ran, notDue, deferred };
}
