// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin batch operations (epic #1644, R5, issue #1646).
 *
 * With the `batch_jobs` grant, a plugin declares operations that run outside
 * the admin: in the same Deno sandbox, inside a job container started from
 * the release's own signed image, with the plugin's own grants and nothing
 * more. The job holds no database credential; its storage, collection and
 * page-output calls go to the admin over the job protocol. Work that is too
 * big for a request (a backfill over 50,000 pages) belongs here instead of
 * being chunked across scheduler ticks.
 */

import { z } from "zod";
import type { PageOutputFacts } from "./page-output.js";

/** When a batch operation may start. */
export const BATCH_TRIGGERS = ["activation", "operator", "stage"] as const;
export type BatchTrigger = (typeof BATCH_TRIGGERS)[number];

/** Manifest form of one batch operation. */
export const pluginBatchOperation = z
  .object({
    /** The operation that runs; it must be in `operations`. */
    operation: z.string().min(1).max(120),
    description: z.string().min(1).max(600),
    triggers: z.array(z.enum(BATCH_TRIGGERS)).min(1).max(3),
    /** Longest run; the job is stopped after it. */
    maxRunSeconds: z.number().int().min(60).max(3600),
    /** The run may page through every page's output of the newest Stage (needs `page_output`). */
    pageOutput: z.boolean().default(false),
  })
  .strict();
export type PluginBatchOperation = z.infer<typeof pluginBatchOperation>;

/** Most batch operations per plugin. */
export const MAX_BATCH_OPERATIONS = 4;

/** What a batch operation is called with. */
export interface PluginBatchArgs {
  readonly trigger: BatchTrigger;
  /** The Stage whose output a `pageOutput` run reads, null otherwise. */
  readonly runId: string | null;
  /** Free-form input of an operator start. */
  readonly input: Readonly<Record<string, unknown>>;
}

/** Page through every page of the newest Stage, for a `pageOutput` batch. */
export interface PluginPageOutputReader {
  /** The next batch of facts, or null after the last one. */
  next(): Promise<readonly PageOutputFacts[] | null>;
  /** Published pages in the Stage. */
  readonly total: number;
}
