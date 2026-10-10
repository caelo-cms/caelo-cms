// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — shared Zod shapes and SQL helpers of the quality-audit ops.
 */

import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { QUALITY_CATEGORIES } from "../../quality/ratchet.js";
import { jsonbParam } from "../../sql-helpers.js";

export const categorySchema = z.enum(QUALITY_CATEGORIES);

export const classificationReasonSchema = z
  .object({
    rule: z.enum([
      "module_code",
      "layout",
      "template",
      "theme",
      "new_page",
      "plugin_config",
      "first_stage",
      "plugin_activation",
      "no_chat_context",
      "previous_not_clean",
    ]),
    entityId: z.string().nullable(),
    label: z.string(),
  })
  .strict();

export const stageClassificationSchema = z
  .object({
    auditNeeded: z.boolean(),
    reasons: z.array(classificationReasonSchema),
    skipped: z.array(z.string()),
  })
  .strict();

/** An element a Lighthouse audit flagged (selector, HTML, why). */
const flaggedElementSchema = z
  .object({
    selector: z.string().optional(),
    snippet: z.string().optional(),
    label: z.string().optional(),
    explanation: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

export const failingAuditSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    score: z.number(),
    categories: z.array(categorySchema),
    displayValue: z.string().optional(),
    elements: z.array(flaggedElementSchema).optional(),
  })
  .strict();

export const problemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("failing_audit"),
      auditId: z.string(),
      title: z.string(),
      score: z.number(),
      categories: z.array(categorySchema),
      displayValue: z.string().optional(),
      elements: z.array(flaggedElementSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("score_below_baseline"),
      category: categorySchema,
      score: z.number().int(),
      baseline: z.number().int(),
    })
    .strict(),
]);

export const heldBackSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("performance_drop"),
      score: z.number().int(),
      baseline: z.number().int(),
    })
    .strict(),
  z
    .object({ kind: z.literal("performance_finding"), auditId: z.string(), title: z.string() })
    .strict(),
]);

export const auditRunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "problems",
  "errored",
  "skipped",
  "superseded",
]);

/** `= ANY(...)` operand for a list of uuids, bound as ONE jsonb parameter
 *  (no string-inlined array literal). */
export function uuidList(ids: readonly string[]): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${jsonbParam(ids)})::uuid)`;
}

/** Timestamp column → ISO string (bun-sql returns Date or string). */
export function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** jsonb column → parsed value (bun-sql may hand back text). */
export function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}
