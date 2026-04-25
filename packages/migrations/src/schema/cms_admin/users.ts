// SPDX-License-Identifier: MPL-2.0

import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";

/**
 * A CMS admin user. Every user also has a row in `actors` with the same id —
 * user-created content is attributed via `actors.id`. First-run bootstrap
 * creates one Owner user whose password must be set during the `/setup`
 * wizard; subsequent signup endpoints are disabled.
 */
export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .references(() => actors.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /** True only for the first Owner created during `/setup`; used to disable the setup route afterwards. */
  isFirstOwner: boolean("is_first_owner").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft-delete marker — non-null means the account is disabled. Hard delete
   * would FK-cascade through actors → audit_events and erase history. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
