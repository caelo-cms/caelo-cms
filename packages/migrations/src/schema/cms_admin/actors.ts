// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Actor = anyone (or anything) issuing Query API operations: a human Owner, an AI
 * session, a plugin sandbox, or the system itself. Placeholder for the real user
 * model in P2 — we need it now so RLS policies have a foreign key target.
 */
export const actors = pgTable("actors", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["human", "ai", "plugin", "system"] }).notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
