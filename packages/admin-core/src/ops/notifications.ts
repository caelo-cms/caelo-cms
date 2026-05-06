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
 * P20 ship 4 + P21 ship 5 — also surfaces the "newer release available"
 * hint (`upgradeAvailable` + `latestVersion`). The GitHub fetch USED to
 * happen inline in the op handler (a transaction-scoped network call,
 * which held a Postgres connection open for up to 5s on a slow GitHub).
 * That created a connection-pool exhaustion vector under load.
 *
 * Now: a background worker (`release-check-worker.ts`) polls GitHub
 * every hour and writes to `release_check_cache`. This op just reads
 * the table — pure Postgres, no network in the tx.
 *
 * Single op (not four) so the AppShell makes one network call per
 * poll. Adapter / Validator runs in the same actor scope as the
 * caller so the read is RLS-safe.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { CAELO_VERSION, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const notificationsRow = z.object({
  pendingProposals: z.number().int().nonnegative(),
  failedDeploys: z.number().int().nonnegative(),
  staleBranches: z.number().int().nonnegative(),
  upgradeAvailable: z.boolean(),
  latestVersion: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  total: z.number().int().nonnegative(),
});

/**
 * Compare two semver strings; returns true when `latest` > `current`.
 * Treats pre-release tags as < the same X.Y.Z stable. Mirrors the
 * comparison in scripts/release.ts so the upgrade hint matches the
 * release pipeline's own ordering.
 */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): { mmp: [number, number, number]; pre: string | null } => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) return { mmp: [0, 0, 0], pre: null };
    return {
      mmp: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? null,
    };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a.mmp[i] ?? 0) > (b.mmp[i] ?? 0)) return true;
    if ((a.mmp[i] ?? 0) < (b.mmp[i] ?? 0)) return false;
  }
  // Same X.Y.Z → pre-release < stable < higher pre-release-string.
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  if (a.pre && b.pre) return a.pre > b.pre;
  return false;
}

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
             AND published_at IS NULL) AS stale_branches,
        (SELECT latest_version FROM release_check_cache WHERE id = 1) AS latest_version,
        (SELECT release_url    FROM release_check_cache WHERE id = 1) AS release_url
    `)) as unknown as {
      pending_proposals: number | string;
      failed_deploys: number | string;
      stale_branches: number | string;
      latest_version: string | null;
      release_url: string | null;
    }[];
    const r = rows[0] ?? {
      pending_proposals: 0,
      failed_deploys: 0,
      stale_branches: 0,
      latest_version: null,
      release_url: null,
    };
    const toInt = (v: number | string): number =>
      typeof v === "string" ? Number.parseInt(v, 10) : v;
    const pendingProposals = toInt(r.pending_proposals);
    const failedDeploys = toInt(r.failed_deploys);
    const staleBranches = toInt(r.stale_branches);

    const latestVersion = r.latest_version;
    const releaseUrl = r.release_url;
    const upgradeAvailable = latestVersion !== null && isNewerVersion(latestVersion, CAELO_VERSION);

    return ok({
      pendingProposals,
      failedDeploys,
      staleBranches,
      upgradeAvailable,
      latestVersion,
      releaseUrl,
      // Bell badge count includes "1" for the upgrade tile so the
      // operator notices a new release the same way they notice a
      // pending proposal.
      total: pendingProposals + failedDeploys + staleBranches + (upgradeAvailable ? 1 : 0),
    });
  },
});
