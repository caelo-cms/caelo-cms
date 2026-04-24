// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * P1-only adversarial fixture: a minimal plugin-data table that exists solely so
 * the RLS adversarial test matrix can try cross-plugin INSERT/SELECT attempts.
 * Real plugin tables register themselves in P11 via the plugin SDK; this table
 * is removed from the build then.
 */
export const rlsSentinel = pgTable("rls_sentinel", {
  pluginId: text("plugin_id").notNull(),
  payload: text("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
