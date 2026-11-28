// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1776 — the job capacity ledger's ops (migration 0920).
 *
 *   job_capacity.set_budget         record the last budget read (the quota, or the machine)
 *   job_capacity.book               a job's lead or a capture books its vCPU: starts or waits
 *   job_capacity.admit              start what fits now, add helpers to elastic work
 *   job_capacity.reserve_lighthouse a quality check's next Lighthouse batch books its width
 *   job_capacity.record_execution   where a booking runs
 *   job_capacity.release            a helper, a Lighthouse batch or a capture gives its vCPU back
 *   job_capacity.leave              one task of a helper ended
 *   job_capacity.cancel             work that waited for CPU is no longer wanted (a stopped batch)
 *   job_capacity.list               what runs and what waits (the Owner's card, the AI)
 *   job_capacity.sweep              give back what stopped without a word
 *
 * Every op that decides takes one transaction-scoped advisory lock, so two
 * admin instances never admit against the same free vCPU. The decisions are
 * job-capacity/plan.ts's; these ops only read the bookings and apply them.
 * A work's bookings and pieces end with the work (`reporting_jobs.finish`)
 * and its helpers and batches with its attempt (`reporting_jobs.begin_attempt`).
 *
 * System-only except `list`: the launcher, the report endpoint and the tick
 * run them as the system actor. Unaudited apart from the starts of waiting
 * work and of helpers: a booking per capture would write an audit row per
 * screenshot that says nothing the capture's own log does not.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  auditReserveVcpu,
  BOOKING_ROLES,
  CAPACITY_CLASSES,
  describeWait,
  LIGHTHOUSE_RUN_VCPU,
  lighthouseGrant,
  type PlanBooking,
  planAdmission,
} from "../job-capacity/plan.js";
import {
  hashJobToken,
  JOB_TIMING,
  mintJobToken,
  type ReportingJobKind,
} from "../reporting-jobs/protocol.js";
import { MAX_JOB_TASKS } from "../reporting-jobs/run-capacity.js";

const kindName = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const uuid = z.string().uuid();
const attempt = z.number().int().min(1).max(20);

/** One transaction-scoped lock for every decision of the ledger. */
export const LEDGER_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('caelo.job_capacity'))`;

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

interface BookingRow {
  id: string;
  kind: string;
  subject_id: string;
  attempt: number | null;
  role: PlanBooking["role"];
  class: PlanBooking["cls"];
  state: PlanBooking["state"];
  vcpu_per_task: number;
  tasks: number;
  max_tasks: number;
  wanted_tasks: number;
  elastic: boolean;
  reserve_vcpu: number;
  waiting_reason: string | null;
  execution: string | null;
  created_ms: number;
  started_ms: number | null;
}

const BOOKING_COLUMNS = sql`id::text AS id, kind, subject_id::text AS subject_id, attempt, role,
  class, state, vcpu_per_task, tasks, max_tasks, wanted_tasks, elastic, reserve_vcpu,
  waiting_reason, execution,
  (extract(epoch FROM created_at) * 1000)::float8 AS created_ms,
  (extract(epoch FROM started_at) * 1000)::float8 AS started_ms`;

/** Every booking (a few dozen at most: one per running or waiting execution). */
export async function readBookings(tx: Tx): Promise<BookingRow[]> {
  return (await tx.execute(
    sql`SELECT ${BOOKING_COLUMNS} FROM job_capacity_bookings ORDER BY created_at, id`,
  )) as unknown as BookingRow[];
}

/** The last budget read; `known: false` before the first start that reads one. */
export async function readBudget(
  tx: Tx,
): Promise<{ readonly known: boolean; readonly budgetVcpu: number | null }> {
  const rows = (await tx.execute(
    sql`SELECT budget_vcpu FROM job_capacity_budget WHERE id = 1`,
  )) as unknown as { budget_vcpu: number | null }[];
  const row = rows[0];
  return row ? { known: true, budgetVcpu: row.budget_vcpu } : { known: false, budgetVcpu: null };
}

/** A row as the planner sees it. */
export function toPlanBooking(r: BookingRow): PlanBooking {
  return {
    id: r.id,
    kind: r.kind,
    subjectId: r.subject_id,
    role: r.role,
    cls: r.class,
    state: r.state,
    vcpuPerTask: r.vcpu_per_task,
    tasks: r.tasks,
    wantedTasks: r.elastic ? Math.min(r.max_tasks, r.wanted_tasks) : 1,
    elastic: r.elastic,
    reserveVcpu: r.reserve_vcpu,
    createdAt: r.created_ms,
  };
}

function internal(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message, internal: true as const });
}

export const setJobCapacityBudgetOp = defineOperation({
  name: "job_capacity.set_budget",
  readScope: "request",
  // Why system-only: the launcher records what it read at a job's start.
  // Unaudited: a reading, overwritten by the next one.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      source: z.enum(["quota", "machine"]),
      budgetVcpu: z.number().int().min(0).max(1_000_000).nullable(),
      quotaVcpu: z.number().int().min(0).max(1_000_000).nullable(),
      reserveVcpu: z.number().int().min(0).max(1000),
      projectId: z.string().min(1).max(100).nullable(),
      region: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO job_capacity_budget (id, source, budget_vcpu, quota_vcpu, reserve_vcpu, project_id, region, read_at)
      VALUES (1, ${input.source}, ${input.budgetVcpu}, ${input.quotaVcpu}, ${input.reserveVcpu},
              ${input.projectId}, ${input.region}, now())
      ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, budget_vcpu = EXCLUDED.budget_vcpu,
        quota_vcpu = EXCLUDED.quota_vcpu, reserve_vcpu = EXCLUDED.reserve_vcpu,
        project_id = EXCLUDED.project_id, region = EXCLUDED.region, read_at = now()
    `);
    return ok({});
  },
});

export const bookJobCapacityOp = defineOperation({
  name: "job_capacity.book",
  // Why site-wide: whether a job may start depends on every booking of the
  // install (a few dozen rows at most: one per running or waiting execution).
  readScope: "site",
  // Why system-only: the launcher books before it starts an execution.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind: kindName,
      subjectId: uuid,
      /** A job's own execution, or a capture. */
      role: z.enum(["lead", "capture"]),
      cls: z.enum(CAPACITY_CLASSES),
      vcpuPerTask: z.number().int().min(1).max(8),
      /** Its tasks claim pieces and helpers may join, up to `maxTasks`. */
      elastic: z.boolean(),
      maxTasks: z.number().int().min(1).max(MAX_JOB_TASKS),
      /** A quality check: keep its Lighthouse share free from now to its end. */
      auditReserve: z.boolean(),
      /** A capture: when it gives its vCPU back by itself if nobody releases it. */
      leaseSeconds: z.number().int().min(30).max(3600).optional(),
    })
    .strict(),
  output: z.object({
    bookingId: z.string(),
    state: z.enum(["running", "waiting"]),
    /** Why it waits, in operator words. */
    reason: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const op = "job_capacity.book";
    await tx.execute(LEDGER_LOCK);
    const budget = await readBudget(tx);
    if (input.cls !== "immediate" && !budget.known) {
      return internal(
        op,
        `the ${input.kind} job would wait for CPU, but no CPU budget was read yet (the launcher reads it before it books)`,
      );
    }
    const reserve = input.auditReserve ? auditReserveVcpu(budget.budgetVcpu) : 0;
    let id: string | null = null;
    if (input.role === "lead") {
      const existing = (await tx.execute(sql`
        SELECT id::text AS id, state FROM job_capacity_bookings
        WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND role = 'lead'
      `)) as unknown as { id: string; state: "running" | "waiting" }[];
      const row = existing[0];
      if (row?.state === "running")
        return ok({ bookingId: row.id, state: "running" as const, reason: null });
      id = row?.id ?? null;
    }
    const immediate = input.cls === "immediate";
    const fresh = id === null;
    if (id === null) {
      const lease =
        input.leaseSeconds === undefined
          ? sql`NULL`
          : sql`now() + make_interval(secs => ${input.leaseSeconds})`;
      const inserted = (await tx.execute(sql`
        INSERT INTO job_capacity_bookings
          (kind, subject_id, role, class, vcpu_per_task, tasks, max_tasks, elastic, reserve_vcpu,
           state, started_at, lease_until)
        VALUES (${input.kind}, ${input.subjectId}::uuid, ${input.role}, ${input.cls}, ${input.vcpuPerTask},
                1, ${input.maxTasks}, ${input.elastic}, ${reserve},
                ${immediate ? "running" : "waiting"}, ${immediate ? sql`now()` : sql`NULL`}, ${lease})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      id = inserted[0]?.id ?? null;
      if (id === null) return internal(op, `the ${input.kind} booking was not written`);
      // Rule 1: an immediate job always starts.
      if (immediate) return ok({ bookingId: id, state: "running" as const, reason: null });
    }
    const plan = planAdmission(budget.budgetVcpu, (await readBookings(tx)).map(toPlanBooking));
    if (plan.start.includes(id)) {
      await tx.execute(sql`
        UPDATE job_capacity_bookings SET state = 'running', started_at = now(), waiting_reason = NULL
         WHERE id = ${id}::uuid
      `);
      return ok({ bookingId: id, state: "running" as const, reason: null });
    }
    const why = plan.waiting.get(id);
    if (!why) return internal(op, `the ${input.kind} booking neither starts nor waits`);
    const reason = describeWait(why);
    await tx.execute(
      sql`UPDATE job_capacity_bookings SET waiting_reason = ${reason} WHERE id = ${id}::uuid`,
    );
    // Once, when it joins the queue: the backstop books a waiting job again
    // on every tick, which only refreshes its reason.
    if (fresh) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: { kind: input.kind, subjectId: input.subjectId },
        succeeded: true,
        entityId: input.subjectId,
        resultSummary: `${input.kind} ${reason}`.slice(0, 300),
      });
    }
    return ok({ bookingId: id, state: "waiting" as const, reason });
  },
});

export const admitJobCapacityOp = defineOperation({
  name: "job_capacity.admit",
  // Why site-wide: admission weighs every booking of the install (a few
  // dozen rows at most).
  readScope: "site",
  // Why system-only: the tick and the reports that free CPU run it.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** Waiting jobs that may start now: the caller starts their attempt. */
    leads: z.array(z.object({ kind: z.string(), subjectId: z.string() })),
    /** Helpers to launch now, with their tokens (stored only as hashes). */
    helpers: z.array(
      z.object({
        bookingId: z.string(),
        kind: z.string(),
        subjectId: z.string(),
        attempt,
        tasks: z.number().int().min(1).max(MAX_JOB_TASKS),
        token: z.string(),
      }),
    ),
  }),
  handler: async (ctx, _input, tx) => {
    await tx.execute(LEDGER_LOCK);
    const budget = await readBudget(tx);
    if (!budget.known) return ok({ leads: [], helpers: [] });
    const rows = await readBookings(tx);
    const plan = planAdmission(budget.budgetVcpu, rows.map(toPlanBooking));
    const leads: { kind: string; subjectId: string }[] = [];
    for (const id of plan.start) {
      const started = (await tx.execute(sql`
        UPDATE job_capacity_bookings SET state = 'running', started_at = now(), waiting_reason = NULL
         WHERE id = ${id}::uuid AND state = 'waiting'
        RETURNING kind, subject_id::text AS subject_id, role
      `)) as unknown as { kind: string; subject_id: string; role: string }[];
      const s = started[0];
      if (s?.role === "lead") leads.push({ kind: s.kind, subjectId: s.subject_id });
    }
    for (const [id, why] of plan.waiting) {
      await tx.execute(sql`
        UPDATE job_capacity_bookings SET waiting_reason = ${describeWait(why)} WHERE id = ${id}::uuid
      `);
    }
    const helpers: {
      bookingId: string;
      kind: string;
      subjectId: string;
      attempt: number;
      tasks: number;
      token: string;
    }[] = [];
    for (const [leadId, add] of plan.widen) {
      const lead = rows.find((r) => r.id === leadId);
      if (!lead) continue;
      // Only an attempt that runs (launched, its lease alive) gets helpers:
      // they serve that attempt and stop with it.
      const live = (await tx.execute(sql`
        SELECT attempt FROM reporting_jobs
        WHERE kind = ${lead.kind} AND subject_id = ${lead.subject_id}::uuid AND state = 'running'
          AND execution IS NOT NULL AND lease_until > now()
      `)) as unknown as { attempt: number }[];
      const at = live[0]?.attempt;
      if (at === undefined) continue;
      const token = mintJobToken();
      const firstLease = JOB_TIMING[lead.kind as ReportingJobKind].firstLeaseSeconds;
      const inserted = (await tx.execute(sql`
        INSERT INTO job_capacity_bookings
          (kind, subject_id, attempt, role, class, vcpu_per_task, tasks, state, started_at, lease_until, token_hash)
        VALUES (${lead.kind}, ${lead.subject_id}::uuid, ${at}, 'helper', ${lead.class}, ${lead.vcpu_per_task},
                ${add}, 'running', now(), now() + make_interval(secs => ${firstLease}), ${hashJobToken(token)})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const bookingId = inserted[0]?.id;
      if (!bookingId) continue;
      helpers.push({
        bookingId,
        kind: lead.kind,
        subjectId: lead.subject_id,
        attempt: at,
        tasks: add,
        token,
      });
    }
    if (leads.length > 0 || helpers.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "job_capacity.admit",
        input: {},
        succeeded: true,
        resultSummary: [
          ...leads.map((l) => `${l.kind} ${l.subjectId} starts`),
          ...helpers.map((h) => `${h.kind} ${h.subjectId}: ${h.tasks} more task(s)`),
        ]
          .join("; ")
          .slice(0, 300),
      });
    }
    return ok({ leads, helpers });
  },
});

export const reserveLighthouseOp = defineOperation({
  name: "job_capacity.reserve_lighthouse",
  // Why site-wide: a batch's width depends on every booking of the install.
  readScope: "site",
  // Why system-only: the quality check's runner asks through its report.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      subjectId: uuid,
      attempt,
      /** Runs the batch has. */
      wanted: z.number().int().min(1).max(64),
      /** The batch's timeout and a margin: its vCPU comes back by then at the latest. */
      leaseSeconds: z.number().int().min(60).max(7200),
    })
    .strict(),
  output: z.object({ bookingId: z.string(), tasks: z.number().int().min(1) }),
  handler: async (_ctx, input, tx) => {
    await tx.execute(LEDGER_LOCK);
    const budget = await readBudget(tx);
    if (!budget.known) {
      return internal(
        "job_capacity.reserve_lighthouse",
        "no CPU budget was read yet: the quality check's start reads it",
      );
    }
    const bookings = (await readBookings(tx)).map(toPlanBooking);
    const tasks = lighthouseGrant(
      budget.budgetVcpu,
      bookings,
      { kind: "quality_audit", subjectId: input.subjectId },
      input.wanted,
    );
    const inserted = (await tx.execute(sql`
      INSERT INTO job_capacity_bookings
        (kind, subject_id, attempt, role, class, vcpu_per_task, tasks, state, started_at, lease_until)
      VALUES ('quality_audit', ${input.subjectId}::uuid, ${input.attempt}, 'lighthouse', 'immediate',
              ${LIGHTHOUSE_RUN_VCPU}, ${tasks}, 'running', now(),
              now() + make_interval(secs => ${input.leaseSeconds}))
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const bookingId = inserted[0]?.id;
    if (!bookingId)
      return internal("job_capacity.reserve_lighthouse", "the batch's booking was not written");
    return ok({ bookingId, tasks });
  },
});

export const recordJobCapacityExecutionOp = defineOperation({
  name: "job_capacity.record_execution",
  readScope: "request",
  // Why system-only: the launcher records where a booking runs. Unaudited:
  // the start that booked it is.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ bookingId: uuid, execution: z.string().min(1).max(400) }).strict(),
  output: z.object({ recorded: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE job_capacity_bookings SET execution = ${input.execution} WHERE id = ${input.bookingId}::uuid
      RETURNING id
    `)) as unknown as unknown[];
    return ok({ recorded: rows.length > 0 });
  },
});

export const releaseJobCapacityOp = defineOperation({
  name: "job_capacity.release",
  readScope: "request",
  // Why system-only: a batch, a capture or a failed launch gives its vCPU
  // back. Unaudited: one per capture.
  actorScope: ["system"],
  database: "cms_admin",
  // The work it belongs to: a job may give back only its own work's bookings.
  input: z.object({ bookingId: uuid, kind: kindName, subjectId: uuid }).strict(),
  output: z.object({ released: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM job_capacity_bookings
       WHERE id = ${input.bookingId}::uuid AND kind = ${input.kind}
         AND subject_id = ${input.subjectId}::uuid AND role <> 'lead'
      RETURNING id
    `)) as unknown as unknown[];
    return ok({ released: rows.length > 0 });
  },
});

export const leaveJobCapacityOp = defineOperation({
  name: "job_capacity.leave",
  readScope: "request",
  // Why system-only: a helper's task reports that it ends. Unaudited: the
  // helper's start is.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({ bookingId: uuid, worker: z.string().regex(/^[0-9a-f-]{36}:\d{1,2}$/) })
    .strict(),
  output: z.object({ left: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    return ok({ left: await leaveHelperTask(tx, input.bookingId, input.worker) });
  },
});

export const cancelJobCapacityOp = defineOperation({
  name: "job_capacity.cancel",
  readScope: "request",
  // Why system-only: the op that ends such work (plugin_batches.stop) runs
  // it after its commit, as the system. Unaudited: that op is.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ kind: kindName, subjectId: uuid }).strict(),
  output: z.object({ cancelled: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    // Only a lead that still waits: running work ends with its job.
    const rows = (await tx.execute(sql`
      DELETE FROM job_capacity_bookings
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
         AND role = 'lead' AND state = 'waiting'
      RETURNING id
    `)) as unknown as unknown[];
    return ok({ cancelled: rows.length > 0 });
  },
});

/**
 * Task `worker` of helper `bookingId` ends: its vCPU comes back; the last
 * one ends the booking. Once per task: a report sent again after its
 * answer was lost finds the task gone and gives nothing back twice.
 */
export async function leaveHelperTask(tx: Tx, bookingId: string, worker: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    UPDATE job_capacity_bookings
       SET tasks = tasks - 1, left_workers = array_append(left_workers, ${worker}::text)
     WHERE id = ${bookingId}::uuid AND role = 'helper' AND tasks > 1
       AND NOT (${worker}::text = ANY(left_workers))
    RETURNING id
  `)) as unknown as unknown[];
  if (rows.length > 0) return true;
  const gone = (await tx.execute(sql`
    DELETE FROM job_capacity_bookings
     WHERE id = ${bookingId}::uuid AND role = 'helper' AND tasks <= 1
       AND NOT (${worker}::text = ANY(left_workers))
    RETURNING id
  `)) as unknown as unknown[];
  return gone.length > 0;
}

/** Whether task `worker` of helper `bookingId` left already (stopped or done). */
export async function helperTaskLeft(tx: Tx, bookingId: string, worker: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM job_capacity_bookings
     WHERE id = ${bookingId}::uuid AND ${worker}::text = ANY(left_workers)
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** A booking as people and the AI see it. */
export const capacityBookingSchema = z.object({
  kind: z.string(),
  subjectId: z.string(),
  role: z.enum(BOOKING_ROLES),
  cls: z.enum(CAPACITY_CLASSES),
  state: z.enum(["running", "waiting"]),
  vcpu: z.number().int(),
  tasks: z.number().int(),
  /** Elastic work: the tasks it would run (lead and helpers together). */
  wantedTasks: z.number().int().nullable(),
  /** A quality check: the part of its Lighthouse share no batch uses now. */
  reserveVcpu: z.number().int(),
  reason: z.string().nullable(),
  /** Since when it runs or waits (ISO). */
  since: z.string(),
});
export type CapacityBooking = z.infer<typeof capacityBookingSchema>;

export const listJobCapacityOp = defineOperation({
  name: "job_capacity.list",
  // Why site-wide: what runs and waits on the install (a few dozen rows).
  readScope: "site",
  // Why human-only: the Owner's Job capacity card (Settings → Deployments)
  // and the system's index-progress width read it. The AI learns the waits
  // it can act on where it looks for them: get_stage_status names a search
  // index that waits for CPU, list_plugin_batches a batch run that does.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    budget: z
      .object({
        source: z.enum(["quota", "machine"]),
        budgetVcpu: z.number().int().nullable(),
        quotaVcpu: z.number().int().nullable(),
        reserveVcpu: z.number().int(),
        projectId: z.string().nullable(),
        region: z.string().nullable(),
        readAt: z.string(),
      })
      .nullable(),
    bookings: z.array(capacityBookingSchema),
  }),
  handler: async (_ctx, _input, tx) => {
    const b = (await tx.execute(sql`
      SELECT source, budget_vcpu, quota_vcpu, reserve_vcpu, project_id, region,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at
      FROM job_capacity_budget WHERE id = 1
    `)) as unknown as {
      source: "quota" | "machine";
      budget_vcpu: number | null;
      quota_vcpu: number | null;
      reserve_vcpu: number;
      project_id: string | null;
      region: string | null;
      read_at: string;
    }[];
    const rows = await readBookings(tx);
    // Helpers and Lighthouse batches count with their work: one line per work.
    const byWork = new Map<string, BookingRow[]>();
    for (const r of rows) {
      if (r.role === "capture") continue;
      const key = `${r.kind}/${r.subject_id}`;
      byWork.set(key, [...(byWork.get(key) ?? []), r]);
    }
    const bookings: CapacityBooking[] = [];
    for (const group of byWork.values()) {
      const lead = group.find((r) => r.role === "lead");
      if (!lead) continue;
      const running = group.filter((r) => r.state === "running");
      // A check's share counts once: what its batches use is in `vcpu`.
      const inUse = running
        .filter((r) => r.role === "lighthouse")
        .reduce((n, r) => n + r.tasks * r.vcpu_per_task, 0);
      bookings.push({
        kind: lead.kind,
        subjectId: lead.subject_id,
        role: "lead",
        cls: lead.class,
        state: lead.state,
        vcpu: running.reduce((n, r) => n + r.tasks * r.vcpu_per_task, 0),
        tasks: running.filter((r) => r.role !== "lighthouse").reduce((n, r) => n + r.tasks, 0),
        wantedTasks: lead.elastic ? Math.min(lead.max_tasks, lead.wanted_tasks) : null,
        reserveVcpu: Math.max(0, lead.reserve_vcpu - inUse),
        reason: lead.waiting_reason,
        since: new Date(lead.started_ms ?? lead.created_ms).toISOString(),
      });
    }
    const captures = rows.filter((r) => r.role === "capture");
    if (captures.length > 0) {
      const first = Math.min(...captures.map((c) => c.started_ms ?? c.created_ms));
      bookings.push({
        kind: "capture",
        subjectId: captures[0]?.subject_id ?? "",
        role: "capture",
        cls: "immediate",
        state: "running",
        vcpu: captures.reduce((n, c) => n + c.tasks * c.vcpu_per_task, 0),
        tasks: captures.length,
        wantedTasks: null,
        reserveVcpu: 0,
        reason: null,
        since: new Date(first).toISOString(),
      });
    }
    const budget = b[0];
    return ok({
      budget: budget
        ? {
            source: budget.source,
            budgetVcpu: budget.budget_vcpu,
            quotaVcpu: budget.quota_vcpu,
            reserveVcpu: budget.reserve_vcpu,
            projectId: budget.project_id,
            region: budget.region,
            readAt: budget.read_at,
          }
        : null,
      bookings,
    });
  },
});

export const sweepJobCapacityOp = defineOperation({
  name: "job_capacity.sweep",
  readScope: "request",
  // Why system-only: the tick gives back the vCPU of executions that
  // stopped without a word.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(1000) }).strict(),
  output: z.object({ released: z.number().int() }),
  handler: async (ctx, input, tx) => {
    // Helpers, batches and captures whose lease passed (their tasks stopped
    // renewing it), and leads whose work no longer runs: the admin that
    // booked them died before the attempt began, or the row was swept.
    const rows = (await tx.execute(sql`
      DELETE FROM job_capacity_bookings WHERE id IN (
        SELECT id FROM job_capacity_bookings WHERE lease_until < now()
        UNION
        SELECT b.id FROM job_capacity_bookings b
        WHERE b.state = 'running' AND b.role = 'lead' AND b.started_at < now() - interval '15 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM reporting_jobs r
            WHERE r.kind = b.kind AND r.subject_id = b.subject_id AND r.state = 'running'
          )
        LIMIT ${input.limit}
      )
      RETURNING kind, role
    `)) as unknown as { kind: string; role: string }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "job_capacity.sweep",
        input,
        succeeded: true,
        resultSummary: `${rows.length} booking(s) whose execution stopped given back (${[
          ...new Set(rows.map((r) => `${r.kind} ${r.role}`)),
        ].join(", ")})`.slice(0, 300),
      });
    }
    return ok({ released: rows.length });
  },
});
