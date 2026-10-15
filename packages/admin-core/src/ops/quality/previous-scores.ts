// SPDX-License-Identifier: MPL-2.0

/**
 * The scores of a page's previous audit that an audit's scores can fairly
 * be compared with — the basis of get_quality_audit's "dropped since the
 * previous audit" hint.
 *
 * Only a like-for-like comparison is a signal:
 * - Same branch lineage. Chats stage their own preview branch; an audit of
 *   another chat's branch (or of main, for a chat's audit) measured other
 *   changes, so a drop against it says nothing about this chat's work. The
 *   lineage is the chat's `chat_branch_id` (subagents share their parent's
 *   branch); staging deploys outside any chat form the main lineage.
 * - Same CPU calibration, for Performance. Performance depends on the CPU
 *   slowdown Lighthouse applied (cpu-calibration.ts, recorded in
 *   `metrics.cpuCalibration`); a score measured at another multiplier — or
 *   before calibration existed — is a different measurement, and a drop
 *   against it would be a spurious regression. The other categories do
 *   not depend on CPU speed and compare regardless.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { QualityCategory } from "../../quality/ratchet.js";
import { json, uuidList } from "./_shared.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * The previous scores a page's current scores may be compared with: all
 * of them, minus Performance when the two audits ran at a different CPU
 * calibration (null = no calibration recorded; two nulls are the same).
 */
export function comparablePreviousScores(
  previous: Readonly<Record<QualityCategory, number>>,
  previousCpuMultiplier: number | null,
  currentCpuMultiplier: number | null,
): Partial<Record<QualityCategory, number>> {
  if (previousCpuMultiplier === currentCpuMultiplier) return { ...previous };
  const { performance: _differentCalibration, ...rest } = previous;
  return rest;
}

function cpuMultiplier(v: string | number | null): number | null {
  return v === null ? null : Number(v);
}

/**
 * Per page of the audit run: the comparable scores of its newest earlier
 * audit on the same branch lineage. Pages without such an audit are absent.
 *
 * @param runId - the audit run whose pages are compared.
 * @param pageIds - the pages of that run.
 */
export async function loadPreviousScores(
  tx: Tx,
  runId: string,
  pageIds: readonly string[],
): Promise<Map<string, Partial<Record<QualityCategory, number>>>> {
  if (pageIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    WITH cur AS (
      SELECT q.created_at, cs.chat_branch_id
      FROM quality_audit_runs q
      LEFT JOIN chat_sessions cs ON cs.id = q.chat_session_id
      WHERE q.id = ${runId}::uuid
    )
    SELECT DISTINCT ON (prev.page_id)
           prev.page_id::text AS page_id,
           prev.scores,
           prev.metrics -> 'cpuCalibration' ->> 'cpuSlowdownMultiplier' AS previous_cpu,
           now_page.metrics -> 'cpuCalibration' ->> 'cpuSlowdownMultiplier' AS current_cpu
    FROM cur
    JOIN quality_audit_pages now_page ON now_page.audit_run_id = ${runId}::uuid
    JOIN quality_audit_pages prev ON prev.page_id = now_page.page_id
    JOIN quality_audit_runs q ON q.id = prev.audit_run_id
    LEFT JOIN chat_sessions cs ON cs.id = q.chat_session_id
    WHERE now_page.page_id = ANY(${uuidList(pageIds)})
      AND q.created_at < cur.created_at
      AND cs.chat_branch_id IS NOT DISTINCT FROM cur.chat_branch_id
      AND prev.scores IS NOT NULL
    ORDER BY prev.page_id, q.created_at DESC
  `)) as unknown as {
    page_id: string;
    scores: unknown;
    previous_cpu: string | null;
    current_cpu: string | null;
  }[];
  return new Map(
    rows.map((r) => [
      r.page_id,
      comparablePreviousScores(
        json<Record<QualityCategory, number>>(r.scores),
        cpuMultiplier(r.previous_cpu),
        cpuMultiplier(r.current_cpu),
      ),
    ]),
  );
}
