// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6b — notification surface for the AppShell topbar bell. Reads
 * three sources and aggregates a single counter the bell dropdown
 * uses to render a per-source breakdown:
 *
 *   - pendingProposals — site_memory_proposals awaiting Owner review.
 *   - failedDeploys    — deploy targets whose most recent finished run
 *                        failed. A failure that a later successful run
 *                        on the same target superseded is history, not
 *                        an open problem, so it does not count.
 *   - staleBranches    — chat_sessions whose last_active_at is over 14
 *                        days old, no published_at, no archived_at.
 *   - failedRedirectSyncs — #1157: deploy targets whose hosting does not
 *                        serve the saved redirects because the last push
 *                        failed (retried automatically; Settings → Redirects).
 *
 * P20 ship 4 + P21 ship 5 — also surfaces the "newer release available"
 * hint (`upgradeAvailable` + `latestVersion`; #696: `updatesPath` is where
 * the Owner installs it, `platform_updates.status` the full detail). The GitHub fetch USED to
 * happen inline in the op handler (a transaction-scoped network call,
 * which held a Postgres connection open for up to 5s on a slow GitHub).
 * That created a connection-pool exhaustion vector under load.
 *
 * Now: a background worker (`release-check-worker.ts`) polls GitHub
 * every hour and writes to `release_check_cache`. This op just reads
 * the table — pure Postgres, no network in the tx.
 *
 * Epic #901 — `bugForwardingUndecided`: the AI has filed at least one bug
 * report and the Owner has not yet answered whether reports go to the
 * Caelo team. Asked once, when it first matters; answering either way on
 * /settings/bugs clears it.
 *
 * Single op (not four) so the AppShell makes one network call per
 * poll. Adapter / Validator runs in the same actor scope as the
 * caller so the read is RLS-safe.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { CAELO_VERSION, isNewerVersion, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { UPDATES_PATH } from "./platform-updates.js";

const notificationsRow = z.object({
  pendingProposals: z.number().int().nonnegative(),
  failedDeploys: z.number().int().nonnegative(),
  staleBranches: z.number().int().nonnegative(),
  failedRedirectSyncs: z.number().int().nonnegative(),
  upgradeAvailable: z.boolean(),
  latestVersion: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  /** Where the Owner installs the update (#696) — the release notice links here. */
  updatesPath: z.literal(UPDATES_PATH),
  bugForwardingUndecided: z.boolean(),
  total: z.number().int().nonnegative(),
});

export const aggregateNotificationsOp = defineOperation({
  name: "notifications.aggregate",
  readScope: "request",
  // Open to every authenticated actor — the AppShell renders for
  // human + system; AI actors don't render UI but the read is
  // harmless and keeps the schema simple.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: notificationsRow,
  handler: async (_ctx, _input, tx) => {
    // v0.2.32 — `pending_proposals` now sums across every pending
    // table (deploy / layouts / users / roles / snapshots
    // / email_config / ai_providers / mcp_tokens / templates / domains
    // / locales / gateway / site_memory / skills), not just
    // site_memory_proposals. Each branch is a partial-index scan
    // (status='pending'); cheap enough to compute on every bell poll.
    const rows = (await tx.execute(sql`
      WITH pending AS (
        SELECT 1 FROM deploy_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM layout_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM user_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM role_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM snapshot_revert_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM email_config_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM ai_providers_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM mcp_token_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM template_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM domain_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM site_defaults_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM plugin_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM owner_settings_pending_actions WHERE status = 'pending'
        UNION ALL SELECT 1 FROM plugin_rate_limit_proposals WHERE status = 'pending'
        UNION ALL SELECT 1 FROM site_memory_proposals WHERE status = 'pending'
        UNION ALL SELECT 1 FROM skill_proposals WHERE status = 'pending'
        UNION ALL SELECT 1 FROM tool_approval_actions WHERE status = 'pending'
      )
      SELECT
        (SELECT count(*)::int FROM pending) AS pending_proposals,
        -- One row per target: its latest finished run. Running/pending
        -- rows are skipped so an in-flight retry neither hides nor
        -- clears the failure until it actually finishes. No time window:
        -- a target whose last run failed weeks ago is still broken.
        (SELECT count(*)::int FROM (
           SELECT DISTINCT ON (target_id) status
             FROM deploy_runs
            WHERE status IN ('succeeded', 'failed')
            ORDER BY target_id, started_at DESC
         ) latest
          WHERE latest.status = 'failed') AS failed_deploys,
        (SELECT count(*)::int FROM chat_sessions
           WHERE last_active_at < now() - interval '14 days'
             AND archived_at IS NULL
             AND published_at IS NULL) AS stale_branches,
        (SELECT count(*)::int FROM redirect_sync_state
           WHERE wanted_revision > synced_revision
             AND last_error IS NOT NULL) AS failed_redirect_syncs,
        (SELECT latest_version FROM release_check_cache WHERE id = 1) AS latest_version,
        (SELECT release_url    FROM release_check_cache WHERE id = 1) AS release_url,
        ((SELECT bug_forwarding_decided_at IS NULL FROM telemetry_settings WHERE id = 1)
           AND EXISTS (SELECT 1 FROM ai_bug_reports)) AS bug_forwarding_undecided
    `)) as unknown as {
      pending_proposals: number | string;
      failed_deploys: number | string;
      stale_branches: number | string;
      failed_redirect_syncs: number | string;
      latest_version: string | null;
      release_url: string | null;
      bug_forwarding_undecided: boolean | null;
    }[];
    const r = rows[0] ?? {
      pending_proposals: 0,
      failed_deploys: 0,
      stale_branches: 0,
      failed_redirect_syncs: 0,
      latest_version: null,
      release_url: null,
      bug_forwarding_undecided: false,
    };
    const toInt = (v: number | string): number =>
      typeof v === "string" ? Number.parseInt(v, 10) : v;
    const pendingProposals = toInt(r.pending_proposals);
    const failedDeploys = toInt(r.failed_deploys);
    const staleBranches = toInt(r.stale_branches);
    const failedRedirectSyncs = toInt(r.failed_redirect_syncs);

    const latestVersion = r.latest_version;
    const releaseUrl = r.release_url;
    const upgradeAvailable = latestVersion !== null && isNewerVersion(latestVersion, CAELO_VERSION);
    const bugForwardingUndecided = r.bug_forwarding_undecided === true;

    return ok({
      pendingProposals,
      failedDeploys,
      staleBranches,
      failedRedirectSyncs,
      upgradeAvailable,
      latestVersion,
      releaseUrl,
      updatesPath: UPDATES_PATH,
      bugForwardingUndecided,
      // Bell badge count includes "1" for the upgrade tile so the
      // operator notices a new release the same way they notice a
      // pending proposal.
      total:
        pendingProposals +
        failedDeploys +
        staleBranches +
        failedRedirectSyncs +
        (upgradeAvailable ? 1 : 0) +
        (bugForwardingUndecided ? 1 : 0),
    });
  },
});
