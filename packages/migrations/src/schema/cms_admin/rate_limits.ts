// SPDX-License-Identifier: MPL-2.0

import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Postgres-backed sliding-window rate-limit buckets, shared across admin
 * replicas. Replaces the per-process Map limiter from P2.1; the in-memory
 * variant lives only in tests now.
 *
 * `key` encodes the dimension being limited — typically `<op>:<ip>` for
 * per-IP login limits, but plug-able to whatever the caller wants.
 */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
