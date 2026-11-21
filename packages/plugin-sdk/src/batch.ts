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
    /** Longest run; the job is stopped after it. */
    maxRunSeconds: z.number().int().min(60).max(3600),
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
}

/** Bytes a batch operation's result may take; the run keeps it for the panel and the AI. */
export const MAX_BATCH_RESULT_BYTES = 64 * 1024;
