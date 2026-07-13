// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * issue #28 — the run-scoped error/warning LEDGER for a website migration.
 * One row per problem hit while a migration runs (a skipped media asset, a
 * page that fails the fidelity gate, a crawl fetch error). `imports.get_run_report`
 * reads them back ordered by severity so every error/warning is reviewable
 * in the closing report — not just the single last-fatal `import_runs.error_message`.
 *
 * `run_id` references `import_runs(id)` in SQL (ON DELETE CASCADE); that table
 * is not modelled in drizzle, so the FK is expressed only in the migration.
 * `page_id` is intentionally not a FK — an event may point at either a staging
 * import_pages id or a composed pages id, and must survive its target's cleanup.
 */
export const importRunEvents = pgTable("import_run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  severity: text("severity", { enum: ["warning", "error", "info"] }).notNull(),
  phase: text("phase"),
  message: text("message").notNull(),
  detail: jsonb("detail"),
  pageId: uuid("page_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
