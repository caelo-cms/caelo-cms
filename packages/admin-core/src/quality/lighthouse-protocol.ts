// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the wire format between the admin process and the
 * Lighthouse child process (`lighthouse-child.ts`). The parent writes one
 * `AuditJob` as JSON to the child's stdin; the child answers with one JSON
 * object per line on stdout. Both sides validate with these schemas.
 */

import { z } from "zod";
import { MAX_FLAGGED_ELEMENTS } from "./lighthouse-extract.js";
import { PERFORMANCE_METRICS, type PerformanceMetricId } from "./lighthouse-metrics.js";
import { QUALITY_CATEGORIES } from "./ratchet.js";

const categorySchema = z.enum(QUALITY_CATEGORIES);

export const auditJobSchema = z
  .object({
    pages: z.array(z.object({ pageId: z.string().uuid(), url: z.string().url() }).strict()).min(1),
    /** Lighthouse runs per page for the Performance median (>= 1). */
    performanceRuns: z.number().int().min(1).max(5),
  })
  .strict();

export type AuditJob = z.infer<typeof auditJobSchema>;

const flaggedElementSchema = z
  .object({
    selector: z.string().optional(),
    snippet: z.string().optional(),
    label: z.string().optional(),
    explanation: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

const failingAuditSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    score: z.number().min(0).max(1),
    categories: z.array(categorySchema),
    displayValue: z.string().optional(),
    // The kept elements plus the "+N more" marker (#667). A cap of exactly
    // MAX_FLAGGED_ELEMENTS rejected every finding with more flagged items,
    // and one rejected line failed the whole audit run.
    elements: z
      .array(flaggedElementSchema)
      .max(MAX_FLAGGED_ELEMENTS + 1)
      .optional(),
  })
  .strict();

/** One Performance metric (lighthouse-metrics.ts `PerformanceMetric`). */
const performanceMetricSchema = z
  .object({
    id: z.enum(
      PERFORMANCE_METRICS.map((m) => m.id) as [PerformanceMetricId, ...PerformanceMetricId[]],
    ),
    label: z.string(),
    title: z.string(),
    numericUnit: z.enum(["millisecond", "unitless"]),
    numericValue: z.number().nullable(),
    displayValue: z.string().nullable(),
    score: z.number().min(0).max(1).nullable(),
    runValues: z.array(z.number().nullable()).min(1),
    unavailableReason: z.string().min(1).nullable(),
  })
  .strict()
  .refine((m) => (m.numericValue === null) === (m.unavailableReason !== null), {
    message: "a metric is either measured or null with an unavailableReason",
  });

/**
 * The Performance metrics of a page (lighthouse-metrics.ts
 * `PerformanceMetrics`). Shared by the child protocol, `record_result` and
 * the read ops, so every hop validates the same shape.
 */
export const performanceMetricsSchema = z
  .object({
    runs: z.number().int().min(1),
    metrics: z.array(performanceMetricSchema).length(PERFORMANCE_METRICS.length),
    lcpElement: flaggedElementSchema.nullable(),
    lcpBreakdown: z.array(
      z.object({ subpart: z.string(), label: z.string(), durationMs: z.number().int() }).strict(),
    ),
    layoutShifts: z
      .array(
        z
          .object({
            element: flaggedElementSchema,
            score: z.number(),
            causes: z.array(z.string()),
          })
          .strict(),
      )
      .max(5),
    /** The host's benchmark index and the CPU slowdown calibrated to it
     *  (cpu-calibration.ts). Absent on audits recorded before calibration. */
    cpuCalibration: z
      .object({
        benchmarkIndex: z.number().int().min(0),
        cpuSlowdownMultiplier: z.number().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const pageMeasurementSchema = z
  .object({
    scores: z.record(categorySchema, z.number().int().min(0).max(100)),
    failingAudits: z.array(failingAuditSchema),
    metrics: performanceMetricsSchema,
  })
  .strict();

export const childEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      pageId: z.string().uuid(),
      url: z.string(),
      finalUrl: z.string().optional(),
      measurement: pageMeasurementSchema,
      performanceRuns: z.array(z.number().int().min(0).max(100)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-error"),
      pageId: z.string().uuid(),
      url: z.string(),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("fatal"), code: z.string(), message: z.string() }).strict(),
  z.object({ kind: z.literal("done") }).strict(),
]);

export type ChildEvent = z.infer<typeof childEventSchema>;
