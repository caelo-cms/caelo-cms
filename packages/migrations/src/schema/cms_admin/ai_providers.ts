// SPDX-License-Identifier: MPL-2.0

import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Per-provider config (model id, base URL, etc). API keys live in the
 * secrets manager / env, never in this table — `name` is the lookup key
 * the secret store uses.
 */
export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name", {
    enum: ["anthropic", "openai", "google", "local-openai-compat"],
  })
    .notNull()
    .unique(),
  displayName: text("display_name").notNull(),
  config: jsonb("config").notNull().default({}),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
