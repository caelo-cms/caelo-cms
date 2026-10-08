// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the wire format between the admin process and the
 * Lighthouse child process (`lighthouse-child.ts`). The parent writes one
 * `AuditJob` as JSON to the child's stdin; the child answers with one JSON
 * object per line on stdout. Both sides validate with these schemas.
 */

import { z } from "zod";
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
  })
  .strict();

const failingAuditSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    score: z.number().min(0).max(1),
    categories: z.array(categorySchema),
    displayValue: z.string().optional(),
    elements: z.array(flaggedElementSchema).max(5).optional(),
  })
  .strict();

export const pageMeasurementSchema = z
  .object({
    scores: z.record(categorySchema, z.number().int().min(0).max(100)),
    failingAudits: z.array(failingAuditSchema),
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
