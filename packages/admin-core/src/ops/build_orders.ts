// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — the build-order ops (migration 0690): a build that runs
 * inside the request its carrier job holds open (build-carrier/).
 *
 *   build_orders.create          the request that asks for a build writes
 *                                what to build and as whom
 *   build_orders.claim           the carrier's `run` takes it: queued →
 *                                running, once
 *   build_orders.get             where an order stands (the waiting request)
 *   build_orders.finish          the build's outcome
 *   build_orders.request_stop    the operator's Stop, read by the running build
 *   build_orders.give_up         the carrier died (or never started): the
 *                                order fails with where and the next step,
 *                                and its run, if it stopped building, too
 *   build_orders.list_unstarted  queued orders whose carrier never started
 *   build_orders.sweep           drop finished orders after their retention
 *
 * All system-only: the order is the admin's own record. The request that
 * asks for a build writes it with its caller's context as data, and the
 * carrier's report runs it; no person, agent or plugin reads or writes an
 * order directly. Creating, finishing, stopping and giving up are audited.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  BUILD_ORDER_KINDS,
  type BuildOrderKind,
  type BuildOutcome,
  buildOutcomeSchema,
  nextStepAfterLostBuild,
  type OrderActor,
  orderActorSchema,
} from "../build-carrier/order.js";
import { jsonbParam } from "../sql-helpers.js";
import { failRunIfOrphanedInTx } from "./deploy-run-lifecycle.js";

const id = z.string().uuid();
const kind = z.enum(BUILD_ORDER_KINDS);

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
  stopRequested: z.boolean(),
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
      RETURNING kind, input, actor, max_run_seconds, stop_requested_at IS NOT NULL AS stop_requested
    `)) as unknown as {
      kind: BuildOrderKind;
      input: Record<string, unknown>;
      actor: OrderActor;
      max_run_seconds: number | null;
      stop_requested: boolean;
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
          stopRequested: row.stop_requested,
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
  // Why system-only: the request waiting for its build, the running build
  // (for a stop) and the stage status read it as the system actor.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id }).strict(),
  output: z.object({
    order: z
      .object({
        kind,
        state: z.enum(["queued", "running", "done"]),
        outcome: z.unknown().nullable(),
        stopRequested: z.boolean(),
        createdAt: z.string(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
      })
      .nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT kind, state, outcome, stop_requested_at IS NOT NULL AS stop_requested,
             created_at::text AS created_at, started_at::text AS started_at,
             finished_at::text AS finished_at
        FROM build_orders WHERE id = ${input.id}::uuid
    `)) as unknown as {
      kind: BuildOrderKind;
      state: "queued" | "running" | "done";
      outcome: unknown;
      stop_requested: boolean;
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
        stopRequested: row.stop_requested,
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
    // The build's own outcome is the record: it replaces one the backstop
    // wrote because the carrier died (`givenUp`), never another build's.
    const rows = (await tx.execute(sql`
      UPDATE build_orders
         SET state = 'done', outcome = ${jsonbParam(input.outcome)}, finished_at = now()
       WHERE id = ${input.id}::uuid
         AND (state <> 'done' OR (outcome ->> 'givenUp') = 'true')
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
  // operator's Stop on; the running build reads it (build-carrier/run-order.ts).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id }).strict(),
  output: z.object({ requested: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE build_orders SET stop_requested_at = COALESCE(stop_requested_at, now())
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
      resultSummary: `stop requested for ${rows[0]?.kind}`,
    });
    return ok({ requested: true });
  },
});

export const giveUpBuildOrderOp = defineOperation({
  name: "build_orders.give_up",
  readScope: "request",
  // Why system-only: the backstop records a build whose carrier died, or
  // never started, as failed (reporting-jobs/backstop.ts via the kind's giveUp).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ id, message: z.string().min(1).max(2000) }).strict(),
  output: z.object({ givenUp: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const found = (await tx.execute(sql`
      SELECT kind FROM build_orders WHERE id = ${input.id}::uuid AND state <> 'done' FOR UPDATE
    `)) as unknown as { kind: BuildOrderKind }[];
    const row = found[0];
    if (!row) return ok({ givenUp: false });
    const message = `${input.message} ${nextStepAfterLostBuild(row.kind)}`.slice(0, 4000);
    const outcome: BuildOutcome = {
      ok: false,
      error: { kind: "HandlerError", operation: row.kind, message },
      givenUp: true,
    };
    // A build still running somewhere stops at its next look at the order.
    await tx.execute(sql`
      UPDATE build_orders
         SET state = 'done', outcome = ${jsonbParam(outcome)}, finished_at = now(),
             stop_requested_at = COALESCE(stop_requested_at, now())
       WHERE id = ${input.id}::uuid
    `);
    // Its run (where the order's id names one) says the same, once nothing
    // builds it any more; a run still building ends itself on the stop.
    await failRunIfOrphanedInTx(tx, input.id, message);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "build_orders.give_up",
      input: { id: input.id },
      succeeded: true,
      entityId: input.id,
      resultSummary: `${row.kind} given up: ${input.message.slice(0, 200)}`,
    });
    return ok({ givenUp: true });
  },
});

export const listUnstartedBuildOrdersOp = defineOperation({
  name: "build_orders.list_unstarted",
  readScope: "request",
  // Why system-only: the tick's backstop reads it to give up orders whose
  // carrier never started (they are never started late).
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
       WHERE o.state = 'queued'
         AND o.created_at < now() - make_interval(secs => ${input.olderThanSeconds})
         AND NOT EXISTS (
           SELECT 1 FROM reporting_jobs j WHERE j.kind = 'build' AND j.subject_id = o.id)
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
