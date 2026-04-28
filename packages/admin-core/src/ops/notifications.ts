// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6b — notification surface for the AppShell topbar bell. Reads
 * three sources and aggregates a single counter the bell dropdown
 * uses to render a per-source breakdown:
 *
 *   - pendingProposals — site_memory_proposals awaiting Owner review.
 *   - failedDeploys    — deploy_runs.status='failed' in the last 7 days.
 *   - staleBranches    — chat_sessions whose last_active_at is over 14
 *                        days old, no published_at, no archived_at.
 *
 * Single op (not three) so the AppShell makes one network call per
 * poll. Adapter / Validator runs in the same actor scope as the
 * caller so the read is RLS-safe (every authenticated user can see
 * their own notification surface).
 */

import { defineOperation } from "@caelo/query-api";
import { ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const notificationsRow = z.object({
  pendingProposals: z.number().int().nonnegative(),
  failedDeploys: z.number().int().nonnegative(),
  staleBranches: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const aggregateNotificationsOp = defineOperation({
  name: "notifications.aggregate",
  // Open to every authenticated actor — the AppShell renders for
  // human + system; AI actors don't render UI but the read is
  // harmless and keeps the schema simple.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: notificationsRow,
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM site_memory_proposals WHERE status = 'pending') AS pending_proposals,
        (SELECT count(*)::int FROM deploy_runs
           WHERE status = 'failed' AND started_at > now() - interval '7 days') AS failed_deploys,
        (SELECT count(*)::int FROM chat_sessions
           WHERE last_active_at < now() - interval '14 days'
             AND archived_at IS NULL
             AND published_at IS NULL) AS stale_branches
    `)) as unknown as {
      pending_proposals: number | string;
      failed_deploys: number | string;
      stale_branches: number | string;
    }[];
    const r = rows[0] ?? { pending_proposals: 0, failed_deploys: 0, stale_branches: 0 };
    const toInt = (v: number | string): number =>
      typeof v === "string" ? Number.parseInt(v, 10) : v;
    const pendingProposals = toInt(r.pending_proposals);
    const failedDeploys = toInt(r.failed_deploys);
    const staleBranches = toInt(r.stale_branches);
    return ok({
      pendingProposals,
      failedDeploys,
      staleBranches,
      total: pendingProposals + failedDeploys + staleBranches,
    });
  },
});
