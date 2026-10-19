// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — the wire format between the admin and a parallel audit task.
 * The admin starts one container per (page, run) with an `AuditTaskOrder`
 * in its environment; the task writes one `AuditTaskResult` as JSON into
 * the install's audit results store under `order.resultKey`. Both sides
 * validate with these schemas.
 */

import { z } from "zod";
import { PERFORMANCE_METRICS } from "./lighthouse-metrics.js";
import { failingAuditSchema, flaggedElementSchema } from "./lighthouse-protocol.js";
import { QUALITY_CATEGORIES } from "./ratchet.js";
import { stagedBuildSourceSchema } from "./staged-build-source.js";

/**
 * The environment variable that carries a batch's orders (`AuditTaskBatch`).
 * A Cloud Run execution runs the whole batch, each task picking its order
 * by `CLOUD_RUN_TASK_INDEX`; providers without a task index start one task
 * per order with a batch of one.
 */
export const AUDIT_TASK_ENV_VAR = "CAELO_AUDIT_TASK";

/** The environment variable Cloud Run sets to a task's index in its execution. */
export const TASK_INDEX_ENV_VAR = "CLOUD_RUN_TASK_INDEX";

const categorySchema = z.enum(QUALITY_CATEGORIES);

export const auditTaskOrderSchema = z
  .object({
    /** One Lighthouse job of the admin (`AuditJob`); groups its tasks' results. */
    jobId: z.string().uuid(),
    /** Unique within the job; names the result. */
    taskId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    pageId: z.string().uuid(),
    url: z.string().url(),
    /** `all` for the page's full run, `performance` for its extra runs. */
    categories: z.enum(["all", "performance"]),
    /** Absent when `url` is reachable from the task as it is. */
    stagedBuild: stagedBuildSourceSchema.optional(),
    /** Key of the result object in the audit results store. */
    resultKey: z.string().regex(/^[a-z0-9/-]{1,200}\.json$/),
  })
  .strict();

export type AuditTaskOrder = z.infer<typeof auditTaskOrderSchema>;

export const auditTaskBatchSchema = z
  .object({
    /**
     * The admin's Caelo version. The audit job runs the admin's image (the
     * upgrade rolls both together); a task on another version refuses, so a
     * job that lags an upgrade fails loudly instead of measuring with
     * other code.
     */
    version: z.string().min(1),
    orders: z.array(auditTaskOrderSchema).min(1).max(50),
  })
  .strict();

export type AuditTaskBatch = z.infer<typeof auditTaskBatchSchema>;

const runMetricValueSchema = z.union([
  z.object({ value: z.number(), score: z.number().min(0).max(1) }).strict(),
  z.object({ reason: z.string().min(1) }).strict(),
]);

/** One run's metrics (lighthouse-metrics.ts `RunMetrics`). */
export const runMetricsSchema = z
  .object({
    values: z.array(runMetricValueSchema).length(PERFORMANCE_METRICS.length),
    lcpElement: flaggedElementSchema.nullable(),
    lcpBreakdown: z.array(
      z.object({ subpart: z.string(), label: z.string(), durationMs: z.number().int() }).strict(),
    ),
    layoutShifts: z
      .array(
        z
          .object({ element: flaggedElementSchema, score: z.number(), causes: z.array(z.string()) })
          .strict(),
      )
      .max(5),
  })
  .strict();

/** One reduced run (lighthouse-extract.ts `RunMeasurement`). */
export const runMeasurementSchema = z
  .object({
    scores: z.partialRecord(categorySchema, z.number().int().min(0).max(100)),
    failingAudits: z.array(failingAuditSchema),
    metrics: runMetricsSchema,
    finalUrl: z.string().optional(),
    cpuCalibration: z
      .object({
        benchmarkIndex: z.number().int().min(0),
        cpuSlowdownMultiplier: z.number().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const auditTaskResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), taskId: z.string(), run: runMeasurementSchema }).strict(),
  /** Lighthouse could not measure the page (unreachable, 404, …). */
  z
    .object({
      kind: z.literal("run-error"),
      taskId: z.string(),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
  /** The task could not measure anything (browser missing, host too slow). */
  z
    .object({ kind: z.literal("fatal"), taskId: z.string(), code: z.string(), message: z.string() })
    .strict(),
]);

export type AuditTaskResult = z.infer<typeof auditTaskResultSchema>;
