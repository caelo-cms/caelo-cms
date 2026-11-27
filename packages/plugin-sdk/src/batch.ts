// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin batch operations (epic #1644, R5, issue #1646).
 *
 * With the `batch_jobs` grant, a plugin declares operations that run outside
 * the admin, in a job container started from the release's own signed
 * image: an installed plugin in the same Deno sandbox as everywhere else, a
 * shipped one as it runs in the admin. Either way the job holds no database
 * credential and no secret. Every call the operation makes (its storage,
 * its configuration, its collections) goes to the admin as a report, and
 * the admin answers it on the plugin's own grants: the job's word grants
 * nothing. Work too big for a request (re-deriving a collection from
 * stored data, aggregating a week of queries) belongs here instead of
 * being chunked across scheduler ticks.
 *
 * What a batch sees: `ctx.query`, `ctx.adminQuery` (shipped plugins with
 * the grant), `ctx.privateFiles` (shipped plugins with the grant),
 * `ctx.config`, `ctx.collections`, `ctx.api`. Nothing that sends mail,
 * calls an AI or reaches the network. An installed plugin's private
 * storage is author data and reaches only a call made for an author, so
 * its batch gets configuration and collections.
 */

import { z } from "zod";

/**
 * #1776 — the machines a batch operation may name: its job's vCPU and
 * memory. Caelo decides when it runs and how wide (the capacity ledger);
 * the plugin only says what one task of it needs.
 */
export const BATCH_SIZES = {
  S: { vcpu: 1, memoryGiB: 2 },
  M: { vcpu: 2, memoryGiB: 4 },
  L: { vcpu: 4, memoryGiB: 16 },
} as const;
export type BatchSize = keyof typeof BATCH_SIZES;

/** The most tasks a batch in pieces may run at once. */
export const MAX_BATCH_PIECE_TASKS = 32;

/** The most pieces a batch's plan may name. */
export const MAX_BATCH_PIECES = 10_000;

/** When a batch operation may start. */
export const BATCH_TRIGGERS = ["activation", "operator", "stage", "schedule"] as const;
export type BatchTrigger = (typeof BATCH_TRIGGERS)[number];

/** Manifest form of one batch operation. */
export const pluginBatchOperation = z
  .object({
    /** The operation that runs; it must be in `operations`. */
    operation: z.string().min(1).max(120),
    /** What it does, for the Owner and the AI ("Rebuilds the search suggestions from last week's queries"). */
    description: z.string().min(1).max(600),
    /**
     * `activation`: once when the plugin is activated (or updated);
     * `operator`: when a person (or the AI for them) starts it;
     * `stage`: after every successful Stage;
     * `schedule`: on the cron in `schedule`.
     */
    triggers: z.array(z.enum(BATCH_TRIGGERS)).min(1).max(4),
    /** Cron expression (five or six fields) for the `schedule` trigger. */
    schedule: z.string().min(1).max(120).optional(),
    /**
     * Longest run; the job is stopped after it. A batch in pieces: the
     * longest one piece may take (the run as a whole has its job's time).
     */
    maxRunSeconds: z.number().int().min(60).max(3600),
    /**
     * #1776 — the machine one task needs: `S` (1 vCPU, 2 GiB; absent means
     * S), `M` (2 vCPU, 4 GiB) or `L` (4 vCPU, 16 GiB). The Owner sees it at
     * approval; a larger machine costs more per minute.
     */
    size: z.enum(["S", "M", "L"]).optional(),
    /**
     * #1776 — the batch works in pieces: `plan` (one of the plugin's
     * operations) returns `{ pieces: string[] }`, and the operation then
     * runs once per piece with `args.piece`. Caelo runs the pieces on as
     * many tasks as CPU is free, up to `maxTasks`, and a task gives its CPU
     * back after a piece when a job of a higher class needs it. Without
     * `pieces` the batch runs on one task and starts only while a quality
     * check still fits beside it.
     */
    pieces: z
      .object({
        plan: z.string().min(1).max(120),
        maxTasks: z.number().int().min(2).max(MAX_BATCH_PIECE_TASKS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.triggers.includes("schedule") !== (b.schedule !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "a batch has a `schedule` exactly when it has the `schedule` trigger",
      });
    if (new Set(b.triggers).size !== b.triggers.length)
      ctx.addIssue({ code: "custom", path: ["triggers"], message: "a trigger is listed twice" });
  });
export type PluginBatchOperation = z.infer<typeof pluginBatchOperation>;

/** Most batch operations per plugin. */
export const MAX_BATCH_OPERATIONS = 4;

/** What a batch operation is called with. */
export interface PluginBatchArgs {
  readonly trigger: BatchTrigger;
  /** The run, for the plugin's own bookkeeping. */
  readonly batchRunId: string;
  /** The Stage that started a `stage` run, null otherwise. */
  readonly stageRunId: string | null;
  /** Input of an `operator` start (what the person or the AI passed). */
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * #1776 — a batch in pieces: the piece this call works on, as its plan
   * named it. Null for the plan itself and for a batch without pieces.
   */
  readonly piece: string | null;
}

/** What a batch's `pieces.plan` operation returns. */
export const batchPlanResult = z
  .object({ pieces: z.array(z.string().min(1).max(200)).max(MAX_BATCH_PIECES) })
  .strict();

/** Bytes a batch operation's result may take; the run keeps it for the panel and the AI. */
export const MAX_BATCH_RESULT_BYTES = 64 * 1024;
