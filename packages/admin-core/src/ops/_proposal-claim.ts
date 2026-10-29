// SPDX-License-Identifier: MPL-2.0

/**
 * #1225 — an approved Publish live (deploy.execute_proposal,
 * quality_audits.execute_proposal) applies outside any transaction, so its
 * proposal row is not locked while the build runs. It is CLAIMED instead
 * (`claimed_by_run_id` / `claimed_at`, migration 0402). While a claim is
 * live the row stays `pending` but nothing else may decide it: a second
 * Approve, a Reject, an AI's cancel or the stale-proposal GC would
 * otherwise record a decision that contradicts what is being released.
 */

import { type SQL, sql } from "drizzle-orm";

/** How long a claim whose run has not started yet (or a rollback, which has no running row) counts as live. */
export const CLAIM_WITHOUT_RUN_MS = 15 * 60_000;

/**
 * SQL condition, over the columns of a `*_pending_actions` row with claim
 * columns, that is TRUE while the row's claim blocks another decision: its
 * run went live (the approval only waits to be recorded), its run is still
 * running with a live lease, or no run exists yet and the claim is recent.
 */
export function claimBlocksDecision(): SQL {
  return sql`(claimed_at IS NOT NULL AND (
    EXISTS (SELECT 1 FROM deploy_runs r WHERE r.id = claimed_by_run_id
            AND (r.status = 'succeeded'
                 OR (r.status = 'running' AND r.lease_expires_at > clock_timestamp())))
    OR (NOT EXISTS (SELECT 1 FROM deploy_runs r WHERE r.id = claimed_by_run_id)
        AND claimed_at > clock_timestamp() - ${CLAIM_WITHOUT_RUN_MS}::int * interval '1 millisecond')
  ))`;
}

/** The refusal for a decision on a row whose claim blocks it. */
export const CLAIMED_PROPOSAL_MESSAGE =
  "this proposal is being applied right now (an Approve started its Publish live or rollback) — wait for it to finish; Settings → Deployments shows it. Nothing was changed.";
