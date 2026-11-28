// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1776 — the pieces of elastic work (migration 0920): a search
 * index's vector shards, a plugin job's pieces.
 *
 *   job_pieces.register     the lead names a scope's pieces (and which are done already);
 *                           a plugin piece is its key, an index shard its number
 *   job_pieces.claim        a task takes the next open piece, or hears to wait, stop or move on
 *   job_pieces.done         a task finished its piece
 *   job_pieces.open_scopes  the scopes a new helper may work on
 *
 * Every task of the work (the lead and the helpers the ledger added)
 * claims from the same list, so a helper that joins late takes what is
 * left, and one that stops gives back nothing but its unfinished piece: the
 * claim runs out and the piece is open again. A helper's claim is also
 * where it hears that a job of a higher class needs its CPU (`stop`): it
 * ends after the piece it finished, never in the middle of one.
 *
 * A new attempt opens every claim of the attempts before it, in the
 * transaction that begins it (reporting_jobs.begin_attempt), before any of
 * its tasks claims; so registering never opens a claim, and a registration
 * sent again keeps the pieces this attempt's tasks run. A claim of an
 * attempt that was replaced meanwhile hears `stop`.
 *
 * System-only and unaudited: the job reports through the admin's report
 * endpoint, and a claim per piece would write hundreds of audit rows per
 * build that say nothing the job's row does not.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { planAdmission, workKey } from "../job-capacity/plan.js";
import { MAX_JOB_TASKS } from "../reporting-jobs/run-capacity.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  helperTaskLeft,
  LEDGER_LOCK,
  leaveHelperTask,
  readBookings,
  readBudget,
  toPlanBooking,
} from "./job_capacity.js";

const kindName = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const uuid = z.string().uuid();
const scope = z.string().min(1).max(200);
/** A task's name in its work: `lead`, or `<helper booking>:<task index>`. */
export const workerName = z.string().regex(/^(lead|[0-9a-f-]{36}:\d{1,2})$/);

/** The most pieces one scope may have. */
export const MAX_PIECES = 100_000;

/** The longest claim: an hour-long batch piece and its margin (plugin-batches/job.ts). */
export const MAX_CLAIM_SECONDS = 2 * 3600;

export const registerJobPiecesOp = defineOperation({
  name: "job_pieces.register",
  readScope: "request",
  // Why system-only: the lead task reports its plan.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind: kindName,
      subjectId: uuid,
      scope,
      count: z.number().int().min(1).max(MAX_PIECES),
      /** Pieces an earlier attempt or Stage finished (their files exist). */
      done: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(MAX_PIECES - 1),
        )
        .max(MAX_PIECES),
      /**
       * A plugin's piece keys, one per piece, each once; absent for index
       * shards. A piece is its key: a plan that names other keys on a
       * retry keeps the done ones, adds the new ones and drops the open
       * ones it no longer names.
       */
      keys: z.array(z.string().min(1).max(200)).max(MAX_PIECES).optional(),
      /** Tasks the work would run for this scope, the lead included. */
      wantedTasks: z.number().int().min(1).max(MAX_JOB_TASKS),
    })
    .strict()
    .refine((v) => v.keys === undefined || v.keys.length === v.count, {
      message: "one key per piece",
    })
    .refine((v) => v.keys === undefined || new Set(v.keys).size === v.keys.length, {
      message: "a piece key is named twice",
    }),
  output: z.object({ unfinished: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    const done = jsonbParam(input.done);
    if (input.keys) {
      // A plugin piece is its key. The open pieces the plan no longer
      // names go; the keys it names anew join after the existing pieces.
      const keys = jsonbParam(input.keys);
      await tx.execute(sql`
        DELETE FROM job_pieces
         WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND scope = ${input.scope}
           AND state = 'open'
           AND piece_key NOT IN (SELECT jsonb_array_elements_text(${keys}))
      `);
      await tx.execute(sql`
        INSERT INTO job_pieces (kind, subject_id, scope, piece, piece_key, state)
        SELECT ${input.kind}, ${input.subjectId}::uuid, ${input.scope},
               (SELECT COALESCE(max(piece) + 1, 0) FROM job_pieces
                 WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
                   AND scope = ${input.scope}) + k.n - 1,
               k.key, 'open'
        FROM jsonb_array_elements_text(${keys}) WITH ORDINALITY AS k(key, n)
        WHERE NOT EXISTS (
          SELECT 1 FROM job_pieces p
           WHERE p.kind = ${input.kind} AND p.subject_id = ${input.subjectId}::uuid
             AND p.scope = ${input.scope} AND p.piece_key = k.key
        )
      `);
    } else {
      // An index shard is its number in a plan every attempt makes alike.
      await tx.execute(sql`
        INSERT INTO job_pieces (kind, subject_id, scope, piece, piece_key, state)
        SELECT ${input.kind}, ${input.subjectId}::uuid, ${input.scope}, g, NULL,
               CASE WHEN g IN (SELECT jsonb_array_elements_text(${done})::int) THEN 'done' ELSE 'open' END
        FROM generate_series(0, ${input.count - 1}) AS g
        ON CONFLICT (kind, subject_id, scope, piece) DO NOTHING
      `);
    }
    if (input.done.length > 0) {
      // A retry finds pieces an earlier attempt wrote: done, whatever their row says.
      await tx.execute(sql`
        UPDATE job_pieces SET state = 'done', claimed_by = NULL, claim_until = NULL
         WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND scope = ${input.scope}
           AND piece IN (SELECT jsonb_array_elements_text(${done})::int) AND state <> 'done'
      `);
    }
    const left = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM job_pieces
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND scope = ${input.scope}
        AND state <> 'done'
    `)) as unknown as { n: number }[];
    const unfinished = left[0]?.n ?? 0;
    await tx.execute(sql`
      UPDATE job_capacity_bookings
         SET wanted_tasks = LEAST(max_tasks, ${input.wantedTasks}, GREATEST(1, ${unfinished}))
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND role = 'lead'
    `);
    return ok({ unfinished });
  },
});

/** What a claim answers. */
export const pieceClaimSchema = z.union([
  /** Work on this piece; report it done. */
  z.object({ piece: z.number().int(), key: z.string().nullable() }),
  /** Every open piece is taken; others still work on theirs. */
  z.object({ wait: z.literal(true) }),
  /** Every piece of the scope is done. */
  z.object({ none: z.literal(true) }),
  /** A helper: a job of a higher class needs the CPU. End now; nothing is lost. */
  z.object({ stop: z.literal(true) }),
]);
export type PieceClaim = z.infer<typeof pieceClaimSchema>;

export const claimJobPieceOp = defineOperation({
  name: "job_pieces.claim",
  // Why site-wide: a helper's claim weighs every booking of the install (a
  // few dozen rows) to learn whether it must give its CPU back.
  readScope: "site",
  // Why system-only: a task claims through its report.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind: kindName,
      subjectId: uuid,
      scope,
      worker: workerName,
      /** The helper booking the report's token belongs to; null for the lead. */
      helperId: uuid.nullable(),
      /** How long the piece is the worker's; a claim that runs out is open again. */
      claimSeconds: z.number().int().min(60).max(MAX_CLAIM_SECONDS),
      /** How far ahead a helper's booking is kept. */
      leaseSeconds: z.number().int().min(60).max(3600),
      /** The attempt the report was admitted for. */
      attempt: z.number().int().min(1).max(20),
    })
    .strict(),
  output: pieceClaimSchema,
  handler: async (_ctx, input, tx) => {
    // A claim admitted just before a new attempt began, and run after it:
    // its task is the replaced attempt's, which stops (its piece is the new
    // attempt's to claim). The row's lock orders it against begin_attempt.
    const current = (await tx.execute(sql`
      SELECT attempt FROM reporting_jobs
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND state = 'running'
       FOR SHARE
    `)) as unknown as { attempt: number }[];
    const at = current[0]?.attempt;
    if (at === undefined || input.attempt < at) return ok({ stop: true as const });
    if (input.helperId !== null) {
      await tx.execute(LEDGER_LOCK);
      // A claim sent again after its `stop` was lost: the same answer, and
      // the task is not given back twice.
      if (await helperTaskLeft(tx, input.helperId, input.worker))
        return ok({ stop: true as const });
      const budget = await readBudget(tx);
      const bookings = (await readBookings(tx)).map(toPlanBooking);
      const key = workKey({ kind: input.kind, subjectId: input.subjectId });
      const lead = bookings.find((b) => b.role === "lead" && workKey(b) === key);
      const tasks = bookings
        .filter((b) => workKey(b) === key && b.state === "running" && b.role !== "lighthouse")
        .reduce((n, b) => n + b.tasks, 0);
      const grant =
        lead && budget.known
          ? (planAdmission(budget.budgetVcpu, bookings).grants.get(lead.id) ?? tasks)
          : tasks;
      if (!lead || tasks > grant) {
        await leaveHelperTask(tx, input.helperId, input.worker);
        return ok({ stop: true as const });
      }
      await tx.execute(sql`
        UPDATE job_capacity_bookings
           SET lease_until = GREATEST(lease_until, now() + make_interval(secs => ${input.leaseSeconds}))
         WHERE id = ${input.helperId}::uuid
      `);
    }
    const picked = (await tx.execute(sql`
      UPDATE job_pieces p SET state = 'claimed', claimed_by = ${input.worker},
             claim_until = now() + make_interval(secs => ${input.claimSeconds})
      WHERE (p.kind, p.subject_id, p.scope, p.piece) = (
        SELECT kind, subject_id, scope, piece FROM job_pieces
        WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND scope = ${input.scope}
          AND (state = 'open' OR (state = 'claimed' AND claim_until < now()))
        ORDER BY piece
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING p.piece, p.piece_key
    `)) as unknown as { piece: number; piece_key: string | null }[];
    const got = picked[0];
    const notDone = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM job_pieces
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND scope = ${input.scope}
        AND state <> 'done'
    `)) as unknown as { n: number }[];
    const unfinished = notDone[0]?.n ?? 0;
    // What is left caps how wide the work still runs.
    await tx.execute(sql`
      UPDATE job_capacity_bookings SET wanted_tasks = LEAST(wanted_tasks, GREATEST(1, ${unfinished}))
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND role = 'lead'
    `);
    if (got) return ok({ piece: got.piece, key: got.piece_key });
    return ok(unfinished > 0 ? { wait: true as const } : { none: true as const });
  },
});

export const finishJobPieceOp = defineOperation({
  name: "job_pieces.done",
  readScope: "request",
  // Why system-only: a task reports its piece.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind: kindName,
      subjectId: uuid,
      scope,
      piece: z
        .number()
        .int()
        .min(0)
        .max(MAX_PIECES - 1),
    })
    .strict(),
  output: z.object({ recorded: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    // Whoever holds the claim now: a piece done twice (a claim that ran out
    // while its first worker still finished it) is the same piece.
    const rows = (await tx.execute(sql`
      UPDATE job_pieces SET state = 'done', claimed_by = NULL, claim_until = NULL
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND scope = ${input.scope}
         AND piece = ${input.piece}
      RETURNING piece
    `)) as unknown as unknown[];
    return ok({ recorded: rows.length > 0 });
  },
});

export const openJobPieceScopesOp = defineOperation({
  name: "job_pieces.open_scopes",
  readScope: "request",
  // Why system-only: a helper asks where it can help.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ kind: kindName, subjectId: uuid }).strict(),
  output: z.object({ scopes: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT scope FROM job_pieces
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND state <> 'done'
      ORDER BY scope
    `)) as unknown as { scope: string }[];
    return ok({ scopes: rows.map((r) => r.scope) });
  },
});
