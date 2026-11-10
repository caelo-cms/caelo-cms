// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 (#1140 category A) — the reporting-job ops (migration 0680).
 *
 *   reporting_jobs.begin_attempt   start a job's first attempt, or its next
 *                                  one once the lease of the last ran out
 *   reporting_jobs.record_launch   where the attempt runs (the execution)
 *   reporting_jobs.authorize       admit one report: the current attempt,
 *                                  its token, the rate; extends the lease
 *   reporting_jobs.release         end an attempt's lease now, with the
 *                                  reason (a launch that failed, a job
 *                                  that deferred)
 *   reporting_jobs.finish          the work is over; no report is admitted
 *   reporting_jobs.list_expired    running jobs whose lease ran out
 *   reporting_jobs.put_upload_part one part of an input too large for one
 *                                  report
 *   reporting_jobs.read_upload     the parts of one upload, joined, once
 *   reporting_jobs.sweep           drop finished rows after their retention
 *
 * The attempt and the token are the whole admission: a job the backstop
 * replaced reports with an older attempt and is told to stop (`stale`),
 * a report with the right attempt but another token is refused. The token
 * itself never reaches the database, only its SHA-256.
 *
 * All system-only: the job reports through the admin's report endpoint,
 * which runs these as the system actor (reporting-jobs/dispatch.ts). The
 * starts, releases, ends and sweeps are audited; `authorize`, the upload
 * parts and the reads are not — one per report would write thousands of
 * audit rows per audit that say nothing the job's row does not, and what a
 * report changes goes through its own audited op (record_result, …).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { MAX_UPLOAD_CHARS_PER_RUN, REPORTING_JOB_KINDS } from "../reporting-jobs/protocol.js";

const kind = z.enum(REPORTING_JOB_KINDS);
const subjectId = z.string().uuid();
const attempt = z.number().int().min(1).max(20);
const tokenHash = z.string().regex(/^[0-9a-f]{64}$/);

export const beginReportingJobAttemptOp = defineOperation({
  name: "reporting_jobs.begin_attempt",
  readScope: "request",
  // Why system-only: only the admin's launcher (the Stage, a retry, the
  // tick's backstop) starts jobs; nobody starts one by hand.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind,
      subjectId,
      tokenHash,
      /** How long the attempt has for its first report (a cold start included). */
      leaseSeconds: z.number().int().min(30).max(3600),
      /** After this many attempts the work is given up instead. */
      maxAttempts: attempt,
    })
    .strict(),
  output: z.union([
    z.object({ started: z.literal(true), attempt }),
    z.object({
      started: z.literal(false),
      /**
       * `running`: an attempt holds its lease (someone else started it);
       * `finished`: the work is over; `exhausted`: the last attempt died.
       */
      reason: z.enum(["running", "finished", "exhausted"]),
      attempt,
      /** Why the last attempt ended, when it said so (a launch error, a deferral). */
      lastError: z.string().nullable(),
      /** Where the last attempt ran. */
      execution: z.string().nullable(),
    }),
  ]),
  handler: async (ctx, input, tx) => {
    const lease = sql`now() + make_interval(secs => ${input.leaseSeconds})`;
    const fresh = (await tx.execute(sql`
      INSERT INTO reporting_jobs (kind, subject_id, attempt, token_hash, state, lease_until)
      VALUES (${input.kind}, ${input.subjectId}::uuid, 1, ${input.tokenHash}, 'running', ${lease})
      ON CONFLICT (kind, subject_id) DO NOTHING
      RETURNING attempt
    `)) as unknown as { attempt: number }[];
    let started: number | null = fresh[0]?.attempt ?? null;
    if (started === null) {
      const rows = (await tx.execute(sql`
        SELECT attempt, state, lease_until <= now() AS expired, last_error, execution
        FROM reporting_jobs
        WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
        FOR UPDATE
      `)) as unknown as {
        attempt: number;
        state: "running" | "done";
        expired: boolean;
        last_error: string | null;
        execution: string | null;
      }[];
      const row = rows[0];
      if (!row) {
        // The conflicting row was deleted between the two statements: a
        // sweep of a finished row. The work is over either way.
        return ok({
          started: false as const,
          reason: "finished" as const,
          attempt: 1,
          lastError: null,
          execution: null,
        });
      }
      const refuse = (reason: "running" | "finished" | "exhausted") =>
        ok({
          started: false as const,
          reason,
          attempt: row.attempt,
          lastError: row.last_error,
          execution: row.execution,
        });
      if (row.state === "done") return refuse("finished");
      if (!row.expired) return refuse("running");
      if (row.attempt >= input.maxAttempts) return refuse("exhausted");
      await tx.execute(sql`
        DELETE FROM reporting_job_uploads
        WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
      `);
      // `last_error` describes the current attempt only: a give-up names
      // why the LAST one ended, not an earlier one's launch failure.
      const next = (await tx.execute(sql`
        UPDATE reporting_jobs
           SET attempt = attempt + 1, token_hash = ${input.tokenHash}, started_at = now(),
               lease_until = ${lease}, execution = NULL, last_report_at = NULL,
               last_error = NULL, window_started_at = now(), window_requests = 0
         WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
        RETURNING attempt
      `)) as unknown as { attempt: number }[];
      started = next[0]?.attempt ?? null;
      if (started === null) {
        return err({
          kind: "HandlerError",
          operation: "reporting_jobs.begin_attempt",
          message: `the ${input.kind} job of ${input.subjectId} vanished while its next attempt started`,
          internal: true,
        });
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "reporting_jobs.begin_attempt",
      input,
      succeeded: true,
      entityId: input.subjectId,
      resultSummary: `${input.kind}: attempt ${started} of ${input.maxAttempts}`,
    });
    return ok({ started: true as const, attempt: started });
  },
});

export const recordReportingJobLaunchOp = defineOperation({
  name: "reporting_jobs.record_launch",
  readScope: "request",
  // Why system-only: see reporting_jobs.begin_attempt. Unaudited: the
  // begin_attempt entry of the same start already records it, and the
  // execution name is on the row.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ kind, subjectId, attempt, execution: z.string().min(1).max(400) }).strict(),
  output: z.object({ recorded: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE reporting_jobs SET execution = ${input.execution}
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
         AND attempt = ${input.attempt} AND state = 'running'
      RETURNING attempt
    `)) as unknown as { attempt: number }[];
    return ok({ recorded: rows.length > 0 });
  },
});

export const authorizeReportingJobOp = defineOperation({
  name: "reporting_jobs.authorize",
  readScope: "request",
  // Why system-only: the report endpoint runs it for the job, after the
  // job's IAP identity was checked (apps/admin lib/server/reporting-jobs.ts).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind,
      subjectId,
      attempt,
      tokenHash,
      /** An admitted report keeps the lease at least this far ahead. */
      leaseSeconds: z.number().int().min(30).max(3600),
      ratePerMinute: z.number().int().min(1).max(10_000),
    })
    .strict(),
  output: z.union([
    z.object({ admitted: z.literal(true) }),
    z.object({
      admitted: z.literal(false),
      /**
       * `stale`: a newer attempt replaced this one; `finished`: the work is
       * over (both: the job stops); `unknown` / `bad-token`: no such
       * attempt or not its token; `rate-limited`: too many reports this
       * minute.
       */
      reason: z.enum(["unknown", "stale", "finished", "bad-token", "rate-limited"]),
      retryAfterSeconds: z.number().int().min(1).optional(),
    }),
  ]),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT attempt, state, token_hash,
             window_started_at <= now() - interval '60 seconds' AS window_over,
             window_requests,
             ceil(extract(epoch FROM window_started_at + interval '60 seconds' - now()))::int AS window_left
      FROM reporting_jobs
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
      FOR UPDATE
    `)) as unknown as {
      attempt: number;
      state: "running" | "done";
      token_hash: string;
      window_over: boolean;
      window_requests: number;
      window_left: number;
    }[];
    const row = rows[0];
    const refuse = (
      reason: "unknown" | "stale" | "finished" | "bad-token" | "rate-limited",
      retryAfterSeconds?: number,
    ) =>
      ok({
        admitted: false as const,
        reason,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    if (!row) return refuse("unknown");
    // The attempt number is not secret; an older one is a job the backstop
    // replaced, which may stop without proving anything more.
    if (input.attempt < row.attempt) return refuse("stale");
    if (input.attempt > row.attempt || input.tokenHash !== row.token_hash) {
      return refuse("bad-token");
    }
    if (row.state === "done") return refuse("finished");
    const requests = row.window_over ? 1 : row.window_requests + 1;
    if (requests > input.ratePerMinute) {
      return refuse("rate-limited", Math.max(1, row.window_left));
    }
    await tx.execute(sql`
      UPDATE reporting_jobs
         SET lease_until = GREATEST(lease_until, now() + make_interval(secs => ${input.leaseSeconds})),
             last_report_at = now(),
             window_started_at = ${row.window_over ? sql`now()` : sql`window_started_at`},
             window_requests = ${requests}
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
    `);
    return ok({ admitted: true as const });
  },
});

export const releaseReportingJobOp = defineOperation({
  name: "reporting_jobs.release",
  readScope: "request",
  // Why system-only: see reporting_jobs.begin_attempt.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind,
      subjectId,
      attempt,
      /** Why the attempt ends, in operator words; the final failure names it. */
      reason: z.string().min(1).max(2000),
    })
    .strict(),
  output: z.object({ released: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE reporting_jobs SET lease_until = now(), last_error = ${input.reason}
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
         AND attempt = ${input.attempt} AND state = 'running'
      RETURNING attempt
    `)) as unknown as { attempt: number }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "reporting_jobs.release",
        input: { kind: input.kind, subjectId: input.subjectId, attempt: input.attempt },
        succeeded: true,
        entityId: input.subjectId,
        resultSummary: `${input.kind} attempt ${input.attempt}: ${input.reason.slice(0, 200)}`,
      });
    }
    return ok({ released: rows.length > 0 });
  },
});

export const finishReportingJobOp = defineOperation({
  name: "reporting_jobs.finish",
  readScope: "request",
  // Why system-only: see reporting_jobs.begin_attempt.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind,
      subjectId,
      /** The attempt that ends it; null when the backstop gives the work up. */
      attempt: attempt.nullable(),
      outcome: z.enum(["completed", "stopped", "given-up"]),
      note: z.string().min(1).max(2000).nullable(),
    })
    .strict(),
  output: z.object({ finished: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE reporting_jobs
         SET state = 'done', finished_at = now(), last_error = COALESCE(${input.note}, last_error)
       WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid AND state = 'running'
         ${input.attempt === null ? sql`` : sql`AND attempt = ${input.attempt}`}
      RETURNING attempt
    `)) as unknown as { attempt: number }[];
    if (rows.length === 0) return ok({ finished: false });
    await tx.execute(sql`
      DELETE FROM reporting_job_uploads
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "reporting_jobs.finish",
      input: { kind: input.kind, subjectId: input.subjectId, outcome: input.outcome },
      succeeded: true,
      entityId: input.subjectId,
      resultSummary: `${input.kind} ${input.outcome} after attempt ${rows[0]?.attempt}${input.note ? `: ${input.note.slice(0, 200)}` : ""}`,
    });
    return ok({ finished: true });
  },
});

export const listExpiredReportingJobsOp = defineOperation({
  name: "reporting_jobs.list_expired",
  readScope: "request",
  // Why system-only: the tick's backstop reads it to restart dead jobs.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ kind, limit: z.number().int().min(1).max(100) }).strict(),
  output: z.object({
    jobs: z.array(
      z.object({
        subjectId: z.string(),
        attempt: z.number().int(),
        execution: z.string().nullable(),
        lastError: z.string().nullable(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT subject_id::text AS subject_id, attempt, execution, last_error
      FROM reporting_jobs
      WHERE kind = ${input.kind} AND state = 'running' AND lease_until <= now()
      ORDER BY lease_until
      LIMIT ${input.limit}
    `)) as unknown as {
      subject_id: string;
      attempt: number;
      execution: string | null;
      last_error: string | null;
    }[];
    return ok({
      jobs: rows.map((r) => ({
        subjectId: r.subject_id,
        attempt: r.attempt,
        execution: r.execution,
        lastError: r.last_error,
      })),
    });
  },
});

export const putReportingJobUploadPartOp = defineOperation({
  name: "reporting_jobs.put_upload_part",
  readScope: "request",
  // Why system-only: see reporting_jobs.authorize, which admitted the report.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind,
      subjectId,
      attempt,
      uploadId: z.string().uuid(),
      part: z.number().int().min(0).max(63),
      data: z.string().min(1).max(2_097_152),
    })
    .strict(),
  output: z.object({ stored: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const held = (await tx.execute(sql`
      SELECT COALESCE(sum(char_length(data)), 0)::bigint AS chars
      FROM reporting_job_uploads
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
        AND NOT (upload_id = ${input.uploadId}::uuid AND part = ${input.part})
    `)) as unknown as { chars: string | number }[];
    if (Number(held[0]?.chars ?? 0) + input.data.length > MAX_UPLOAD_CHARS_PER_RUN) {
      return err({
        kind: "HandlerError",
        operation: "reporting_jobs.put_upload_part",
        message: `the ${input.kind} job's uploads would exceed ${MAX_UPLOAD_CHARS_PER_RUN} characters; its report is larger than any the admin takes`,
        refusal: true,
      });
    }
    // A retried part replaces itself: the job resends a part whose answer it lost.
    await tx.execute(sql`
      INSERT INTO reporting_job_uploads (kind, subject_id, upload_id, part, attempt, data)
      VALUES (${input.kind}, ${input.subjectId}::uuid, ${input.uploadId}::uuid, ${input.part},
              ${input.attempt}, ${input.data})
      ON CONFLICT (kind, subject_id, upload_id, part)
      DO UPDATE SET data = EXCLUDED.data, attempt = EXCLUDED.attempt, created_at = now()
    `);
    return ok({ stored: true });
  },
});

export const readReportingJobUploadOp = defineOperation({
  name: "reporting_jobs.read_upload",
  readScope: "request",
  // Why system-only: see reporting_jobs.authorize, which admitted the report.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      kind,
      subjectId,
      attempt,
      uploadId: z.string().uuid(),
      parts: z.number().int().min(1).max(64),
    })
    .strict(),
  output: z.object({ text: z.string() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT part, attempt, data
      FROM reporting_job_uploads
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
        AND upload_id = ${input.uploadId}::uuid
      ORDER BY part
      FOR UPDATE
    `)) as unknown as { part: number; attempt: number; data: string }[];
    const complete =
      rows.length === input.parts &&
      rows.every((r, i) => r.part === i && r.attempt === input.attempt);
    if (!complete) {
      return err({
        kind: "HandlerError",
        operation: "reporting_jobs.read_upload",
        message: `upload ${input.uploadId} of the ${input.kind} job has ${rows.length} of its ${input.parts} part(s) from this attempt; send every part (upload-part) before the report that names it`,
        refusal: true,
      });
    }
    // Read once: what a run holds in uploads is capped, and a long audit
    // sends many (plugin fact batches). A job whose report failed after
    // this sends its parts again (job-reporter.ts).
    await tx.execute(sql`
      DELETE FROM reporting_job_uploads
      WHERE kind = ${input.kind} AND subject_id = ${input.subjectId}::uuid
        AND upload_id = ${input.uploadId}::uuid
    `);
    return ok({ text: rows.map((r) => r.data).join("") });
  },
});

export const sweepReportingJobsOp = defineOperation({
  name: "reporting_jobs.sweep",
  readScope: "request",
  // Why system-only: the tick's clean-up.
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
      DELETE FROM reporting_jobs
      WHERE (kind, subject_id) IN (
        SELECT kind, subject_id FROM reporting_jobs
        WHERE state = 'done' AND finished_at < now() - make_interval(days => ${input.olderThanDays})
        ORDER BY finished_at
        LIMIT ${input.limit}
      )
      RETURNING subject_id
    `)) as unknown as { subject_id: string }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "reporting_jobs.sweep",
        input,
        succeeded: true,
        resultSummary: `${rows.length} finished job row(s) deleted`,
      });
    }
    return ok({ deleted: rows.length });
  },
});
