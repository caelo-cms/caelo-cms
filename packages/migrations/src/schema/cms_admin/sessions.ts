// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Server-side sessions. The `token` is a random 32-byte URL-safe string stored
 * in an HttpOnly cookie; the `csrf_token` is a separate random value used for
 * the double-submit CSRF pattern. Expired rows are swept lazily at login +
 * logout; a cron sweeper can land later if load demands.
 */
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  csrfToken: text("csrf_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
