// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — the build-order ops (migration 0690): a build that runs
 * inside the request its carrier job holds open (build-carrier/).
 *
 *   build_orders.create          the request that asks for a build writes
 *                                what to build and as whom
 *   build_orders.claim           the carrier's `run` takes it: queued →
 *                                running, once
 *   build_orders.get             where an order stands (the waiting request,
 *                                the running build's look for a stop)
 *   build_orders.finish          the build's outcome
 *   build_orders.request_stop    the operator's Stop, read by the running build
 *   build_orders.give_up         the carrier died (or never started): the
 *                                order ends with what its run shows, or as
 *                                failed with where and the next step
 *   build_orders.list_unstarted  orders no carrier works on any more
 *   build_orders.sweep           drop finished orders after their retention
 *
 * An order ends once, with the outcome its build can no longer change.
 * `give_up` ends it only when no build can still succeed for it: its run
 * ended (the order then says what the run says, a success included), lost
 * its lease (it is marked failed now), or never started — and the run's
 * start refuses a given-up order's id for good (deploy-run-lifecycle.ts
 * `beginRunInTx`). The start and the give-up take one lock on the order's
 * id (deploy-run-lock.ts `lockBuildOrderInTx`), so a give-up never misses a
 * run whose start is not committed yet. A run still building is asked to
 * stop instead and ends the order itself. So the request that waits never
 * reads a failure for a build that then goes live.
 *
 * All system-only: the order is the admin's own record. The request that
 * asks for a build writes it with its caller's context as data, and the
 * carrier's report runs it; no person, agent or plugin writes an order.
 * Creating, finishing, stopping and giving up are audited.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  BUILD_ORDER_KINDS,
  type BuildOrderKind,
  type BuildOutcome,
  buildOutcomeSchema,
  GIVEN_UP_STOP_REASON,
  nextStepAfterLostBuild,
  type OrderActor,
  orderActorSchema,
  stageOrderInputSchema,
} from "../build-carrier/order.js";
import { deployRunIsOrphaned, lockBuildOrderInTx } from "../deploy/deploy-run-lock.js";
import { jsonbParam } from "../sql-helpers.js";
import { failRunIfOrphanedInTx } from "./deploy-run-lifecycle.js";

const id = z.string().uuid();
const kind = z.enum(BUILD_ORDER_KINDS);
const stopReason = z.string().min(1).max(500);

/** The most JSON an order's input may hold (a production build may name every changed page). */
const MAX_INPUT_CHARS = 4 * 1024 * 1024;

export const createBuildOrderOp = defineOperation({
  name: "build_orders.create",
  readScope: "request",
  // Why system-only: the request that asks for a build writes its order as
  // the system actor, with the caller's context as data (build-carrier/carry.ts).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      id,
      kind,
      input: z
        .record(z.string(), z.unknown())
        .refine((v) => JSON.stringify(v).length <= MAX_INPUT_CHARS, {
          message: `an order's input holds at most ${MAX_INPUT_CHARS} characters of JSON`,
        }),
      actor: orderActorSchema,
      maxRunSeconds: z.number().int().min(1).max(3600).nullable(),
    })
    .strict(),
  output: z.object({ created: z.literal(true) }),
  handler: async (ctx, input, tx) => {
    // A Stage's input is checked now, where the person who asked hears it,
    // not in the carrier minutes later.
    if (input.kind === "stage") {
      const stage = stageOrderInputSchema.safeParse(input.input);
      if (!stage.success) {
        return err({
          kind: "HandlerError",
          operation: "build_orders.create",
          message: `a Stage names the chats to stage and who staged them: ${stage.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
            .join("; ")}`,
          refusal: true,
        });
      }
    }
    const rows = (await tx.execute(sql`
      INSERT INTO build_orders (id, kind, input, actor, max_run_seconds)
      VALUES (${input.id}::uuid, ${input.kind}, ${jsonbParam(input.input)},
              ${jsonbParam(input.actor)}, ${input.maxRunSeconds})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "build_orders.create",
        message: `a build order ${input.id} exists already; every build gets a fresh id`,
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "build_orders.create",
      input: { id: input.id, kind: input.kind, actorKind: input.actor.actorKind },
      succeeded: true,
      entityId: input.id,
      resultSummary: `${input.kind} ordered by ${input.actor.actorKind} ${input.actor.actorId}`,
    });
    return ok({ created: true as const });
  },
});

/** What a claim found: the order to run, or why there is nothing to run. */
const claimedOrder = z.object({
  kind,
  input: z.record(z.string(), z.unknown()),
  actor: orderActorSchema,
  maxRunSeconds: z.number().int().nullable(),
  stopReason: z.string().nullable(),
  /** How long the order waited for its carrier: the carrier job's start, as measured. */
  waitedMs: z.number().int().nonnegative(),
});

export const claimBuildOrderOp = defineOperation({
  name: "build_orders.claim",
  readScope: "request",
  // Why system-only: the carrier's `run` report takes the order (build-carrier/run-order.ts).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id }).strict(),
  output: z.object({
    state: z.enum(["claimed", "running", "done", "missing"]),
    order: claimedOrder.nullable(),
    outcome: z.unknown().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const claimed = (await tx.execute(sql`
      UPDATE build_orders SET state = 'running', started_at = now()
       WHERE id = ${input.id}::uuid AND state = 'queued'
      RETURNING kind, input, actor, max_run_seconds,
                CASE WHEN stop_requested_at IS NULL THEN NULL
                     ELSE COALESCE(stop_reason, 'the operator stopped it') END AS stop_reason,
                GREATEST(0, floor(EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) * 1000))::int
                  AS waited_ms
    `)) as unknown as {
      kind: BuildOrderKind;
      input: Record<string, unknown>;
      actor: OrderActor;
      max_run_seconds: number | null;
      stop_reason: string | null;
      waited_ms: number;
    }[];
    const row = claimed[0];
    if (row) {
      return ok({
        state: "claimed" as const,
        order: {
          kind: row.kind,
          input: row.input,
          actor: orderActorSchema.parse(row.actor),
          maxRunSeconds: row.max_run_seconds,
          stopReason: row.stop_reason,
          waitedMs: Number(row.waited_ms),
        },
        outcome: null,
      });
    }
    const found = (await tx.execute(sql`
      SELECT state, outcome FROM build_orders WHERE id = ${input.id}::uuid
    `)) as unknown as { state: "running" | "done"; outcome: unknown }[];
    const current = found[0];
    if (!current) return ok({ state: "missing" as const, order: null, outcome: null });
    return ok({ state: current.state, order: null, outcome: current.outcome ?? null });
  },
});

export const getBuildOrderOp = defineOperation({
  name: "build_orders.get",
  readScope: "request",
  // Why system-only: the request waiting for its build and the running
  // build (for a stop) read it as the system actor.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id }).strict(),
  output: z.object({
    order: z
      .object({
        kind,
        state: z.enum(["queued", "running", "done"]),
        outcome: z.unknown().nullable(),
        /** Why the build is to stop; null while nobody asked it to. */
        stopReason: z.string().nullable(),
        createdAt: z.string(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
      })
      .nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT kind, state, outcome,
             CASE WHEN stop_requested_at IS NULL THEN NULL
                  ELSE COALESCE(stop_reason, 'the operator stopped it') END AS stop_reason,
             created_at::text AS created_at, started_at::text AS started_at,
             finished_at::text AS finished_at
        FROM build_orders WHERE id = ${input.id}::uuid
    `)) as unknown as {
      kind: BuildOrderKind;
      state: "queued" | "running" | "done";
      outcome: unknown;
      stop_reason: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
    }[];
    const row = rows[0];
    if (!row) return ok({ order: null });
    return ok({
      order: {
        kind: row.kind,
        state: row.state,
        outcome: row.outcome ?? null,
        stopReason: row.stop_reason,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      },
    });
  },
});

export const finishBuildOrderOp = defineOperation({
  name: "build_orders.finish",
  readScope: "request",
  // Why system-only: the carrier's `run` records how its build ended.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id, outcome: buildOutcomeSchema }).strict(),
  output: z.object({ finished: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // Once: a given-up order ended with an outcome its build can no longer
    // change (see the file comment).
    const rows = (await tx.execute(sql`
      UPDATE build_orders
         SET state = 'done', outcome = ${jsonbParam(input.outcome)}, finished_at = now()
       WHERE id = ${input.id}::uuid AND state <> 'done'
      RETURNING kind
    `)) as unknown as { kind: BuildOrderKind }[];
    const row = rows[0];
    if (!row) return ok({ finished: false });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "build_orders.finish",
      input: { id: input.id, ok: input.outcome.ok },
      succeeded: true,
      entityId: input.id,
      resultSummary: `${row.kind} ${input.outcome.ok ? "succeeded" : "failed"}`,
    });
    return ok({ finished: true });
  },
});

export const requestBuildOrderStopOp = defineOperation({
  name: "build_orders.request_stop",
  readScope: "request",
  // Why system-only: the request waiting for its build passes the
  // operator's Stop on; the running build reads it (build-carrier/stop-watch.ts).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id, reason: stopReason }).strict(),
  output: z.object({ requested: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE build_orders
         SET stop_requested_at = COALESCE(stop_requested_at, now()),
             stop_reason = COALESCE(stop_reason, ${input.reason})
       WHERE id = ${input.id}::uuid AND state <> 'done'
      RETURNING kind
    `)) as unknown as { kind: BuildOrderKind }[];
    if (rows.length === 0) return ok({ requested: false });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "build_orders.request_stop",
      input: { id: input.id },
      succeeded: true,
      entityId: input.id,
      resultSummary: `stop requested for ${rows[0]?.kind}: ${input.reason.slice(0, 200)}`,
    });
    return ok({ requested: true });
  },
});

/** The order's run (its id is the order's), as give_up judges it. */
async function runOfOrder(
  tx: TransactionRunner,
  orderId: string,
): Promise<{
  status: string;
  error_message: string | null;
  page_count: number | null;
  file_count: number | null;
  build_id: string | null;
} | null> {
  const rows = (await tx.execute(sql`
    SELECT status, error_message, page_count, file_count, build_id
      FROM deploy_runs WHERE id = ${orderId}::uuid
  `)) as unknown as {
    status: string;
    error_message: string | null;
    page_count: number | null;
    file_count: number | null;
    build_id: string | null;
  }[];
  return rows[0] ?? null;
}

export const giveUpBuildOrderOp = defineOperation({
  name: "build_orders.give_up",
  readScope: "request",
  // Why system-only: the backstop ends a build whose carrier died, or never
  // started (reporting-jobs/backstop.ts via the kind's giveUp).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id, message: z.string().min(1).max(2000) }).strict(),
  output: z.object({
    /** `ended`: the order has its outcome now; `stopping`: its run still builds, asked to stop. */
    result: z.enum(["ended", "stopping", "already-ended"]),
  }),
  handler: async (ctx, input, tx) => {
    // First, before any read: a run that is starting for this order holds
    // the lock until its row is committed, and the reads below see it.
    await lockBuildOrderInTx(tx, input.id);
    const found = (await tx.execute(sql`
      SELECT kind FROM build_orders WHERE id = ${input.id}::uuid AND state <> 'done' FOR UPDATE
    `)) as unknown as { kind: BuildOrderKind }[];
    const row = found[0];
    if (!row) return ok({ result: "already-ended" as const });
    const message = `${input.message} ${nextStepAfterLostBuild(row.kind)}`.slice(0, 4000);
    let run = await runOfOrder(tx, input.id);
    if (run?.status === "running" && !(await deployRunIsOrphaned(tx, input.id))) {
      // A build still runs it somewhere: it stops at its next look at the
      // order and records its own outcome — a success past the publish
      // fence included. Ending the order here would tell the waiting
      // request "failed" for a build that may still go live.
      await tx.execute(sql`
        UPDATE build_orders
           SET stop_requested_at = COALESCE(stop_requested_at, now()),
               stop_reason = COALESCE(stop_reason, ${GIVEN_UP_STOP_REASON})
         WHERE id = ${input.id}::uuid
      `);
      return ok({ result: "stopping" as const });
    }
    if (run?.status === "running") {
      // Nothing builds it any more: it fails with where and what next.
      await failRunIfOrphanedInTx(tx, input.id, message);
      run = await runOfOrder(tx, input.id);
    }
    // What the run shows is the outcome: a run that succeeded went live (or
    // staged) even though its carrier never reported back.
    const outcome: BuildOutcome =
      run?.status === "succeeded"
        ? {
            ok: true,
            value: {
              runId: input.id,
              buildId: run.build_id ?? input.id,
              pageCount: run.page_count,
              fileCount: run.file_count,
              recovered: true,
            },
          }
        : {
            ok: false,
            error: {
              kind: "HandlerError",
              operation: row.kind,
              message: run?.status === "failed" && run.error_message ? run.error_message : message,
            },
            givenUp: true,
          };
    await tx.execute(sql`
      UPDATE build_orders
         SET state = 'done', outcome = ${jsonbParam(outcome)}, finished_at = now(),
             stop_requested_at = COALESCE(stop_requested_at, now()),
             stop_reason = COALESCE(stop_reason, ${GIVEN_UP_STOP_REASON})
       WHERE id = ${input.id}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "build_orders.give_up",
      input: { id: input.id },
      succeeded: true,
      entityId: input.id,
      resultSummary: `${row.kind} ended without its carrier (${outcome.ok ? "its run succeeded" : "failed"}): ${input.message.slice(0, 200)}`,
    });
    return ok({ result: "ended" as const });
  },
});

export const listUnstartedBuildOrdersOp = defineOperation({
  name: "build_orders.list_unstarted",
  readScope: "request",
  // Why system-only: the tick's backstop reads it to end the orders no
  // carrier works on: queued without a job (they are never started late),
  // or not ended although their job did (a run that was still building).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(100),
      olderThanSeconds: z.number().int().min(1).max(86_400),
    })
    .strict(),
  output: z.object({ ids: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT o.id::text AS id FROM build_orders o
       WHERE o.state IN ('queued', 'running')
         AND o.created_at < now() - make_interval(secs => ${input.olderThanSeconds})
         AND NOT EXISTS (
           SELECT 1 FROM reporting_jobs j
            WHERE j.kind = 'build' AND j.subject_id = o.id AND j.state = 'running')
       ORDER BY o.created_at
       LIMIT ${input.limit}
    `)) as unknown as { id: string }[];
    return ok({ ids: rows.map((r) => r.id) });
  },
});

export const sweepBuildOrdersOp = defineOperation({
  name: "build_orders.sweep",
  readScope: "request",
  // Why system-only: the daily clean-up of finished orders.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      olderThanDays: z.number().int().min(1).max(90),
      limit: z.number().int().min(1).max(1000),
    })
    .strict(),
  output: z.object({ deleted: z.number().int() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM build_orders WHERE id IN (
        SELECT id FROM build_orders
         WHERE state = 'done'
           AND finished_at < now() - make_interval(days => ${input.olderThanDays})
         ORDER BY finished_at
         LIMIT ${input.limit})
      RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "build_orders.sweep",
        input: { olderThanDays: input.olderThanDays },
        succeeded: true,
        resultSummary: `${rows.length} finished build order(s) swept`,
      });
    }
    return ok({ deleted: rows.length });
  },
});
