// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — the scheduler tick's due-table ops (migration 0550).
 *
 *   scheduled_tasks.claim    lease one task when it is due and unleased
 *   scheduled_tasks.finish   record how the run went and when it is due next
 *
 * The tick (scheduler/tick.ts) claims each task right before it runs it, so
 * a task it never reaches (the tick's time budget ran out) stays due for the
 * next tick instead of sitting leased. Concurrent ticks on several admin
 * instances serialise on the row: the claim's UPDATE requires the task to be
 * due and its lease free, so all but one find nothing to claim.
 *
 * Every row write here is system-only and unaudited per call: a tick every
 * few minutes would write thousands of audit rows a month that say nothing a
 * row of this table does not. What a task itself changes goes through its
 * own audited ops.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** The shape of a due-table key (mirrors migration 0550's CHECK). */
export const SCHEDULED_TASK_KEY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the class EXCLUDES control characters, as the migration's CHECK does.
  /^(core:[a-z0-9_-]{1,80}|plugin:[a-z][a-z0-9-]{0,119}\/[^\x00-\x1f\x7f/]{1,120})$/;

const taskKey = z.string().regex(SCHEDULED_TASK_KEY);
const holder = z.string().min(1).max(200);

export const scheduledTasksClaimOp = defineOperation({
  name: "scheduled_tasks.claim",
  readScope: "request",
  // Why system-only: only the scheduler tick (an authenticated internal
  // request, never a person or the AI) decides what runs when.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      taskKey,
      /** Which tick claims it (instance + tick id), for the lease. */
      holder,
      /** How long the lease holds before another tick may take the task over. */
      leaseSeconds: z.number().int().min(10).max(3600),
    })
    .strict(),
  output: z.object({ claimed: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    // A task the table has never seen is due at once.
    await tx.execute(sql`
      INSERT INTO scheduled_tasks (task_key) VALUES (${input.taskKey})
      ON CONFLICT (task_key) DO NOTHING
    `);
    const rows = (await tx.execute(sql`
      UPDATE scheduled_tasks
         SET lease_holder = ${input.holder},
             lease_until = now() + make_interval(secs => ${input.leaseSeconds}),
             last_started_at = now()
       WHERE task_key = ${input.taskKey}
         AND next_due_at <= now()
         AND (lease_until IS NULL OR lease_until <= now())
       RETURNING task_key
    `)) as unknown as { task_key: string }[];
    return ok({ claimed: rows.length > 0 });
  },
});

export const scheduledTasksFinishOp = defineOperation({
  name: "scheduled_tasks.finish",
  readScope: "request",
  // Why system-only: see scheduled_tasks.claim.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      taskKey,
      holder,
      outcome: z.enum(["ok", "failed"]),
      error: z.string().max(2000).nullable(),
      durationMs: z.number().int().min(0),
      /**
       * When the task is due next: `afterSeconds` counts from the start of
       * this run (an interval task), `at` is an absolute time (a cron
       * worker's next occurrence). Exactly one is set.
       */
      afterSeconds: z
        .number()
        .int()
        .min(0)
        .max(31 * 86_400)
        .nullable(),
      at: z.string().datetime().nullable(),
    })
    .strict()
    .refine((v) => (v.afterSeconds === null) !== (v.at === null), {
      message: "set exactly one of afterSeconds and at",
    }),
  output: z.object({ recorded: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const next =
      input.at !== null
        ? sql`${input.at}::timestamptz`
        : sql`last_started_at + make_interval(secs => ${input.afterSeconds})`;
    const rows = (await tx.execute(sql`
      UPDATE scheduled_tasks
         SET next_due_at = ${next},
             lease_holder = NULL,
             lease_until = NULL,
             last_finished_at = now(),
             last_outcome = ${input.outcome},
             last_error = ${input.error},
             last_duration_ms = ${input.durationMs}
       WHERE task_key = ${input.taskKey}
         AND lease_holder = ${input.holder}
       RETURNING task_key
    `)) as unknown as { task_key: string }[];
    if (rows.length === 0) {
      // Another tick took the task over after this one's lease expired: its
      // record wins, and this run's result is only in the logs.
      return err({
        kind: "HandlerError" as const,
        operation: "scheduled_tasks.finish",
        message: `${input.taskKey} is no longer leased by ${input.holder}: the run outlived its lease and another tick took the task over. Raise the task's lease or make the task shorter.`,
      });
    }
    return ok({ recorded: true });
  },
});
