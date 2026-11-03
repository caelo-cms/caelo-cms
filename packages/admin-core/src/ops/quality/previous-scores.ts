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
 * - Same emulated device, for Performance. Performance depends on the
 *   device Lighthouse emulated (cpu-calibration.ts, recorded in
 *   `metrics.cpuCalibration`); a score measured on another device — or
 *   before calibration existed — is a different measurement, and a drop
 *   against it would be a spurious regression. Since #1370 every run
 *   emulates `targetBenchmarkIndex`, whatever multiplier its host needed,
 *   so two such audits compare by target. Before #1370 the device followed
 *   the host's multiplier, so two of those compare by multiplier, and an
 *   older audit never compares with a newer one. The other categories do
 *   not depend on CPU speed and compare regardless.
 */

import { type defineOperation, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { QualityCategory } from "../../quality/ratchet.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** What an audit recorded about its emulated device; nulls = not recorded. */
export interface RecordedCalibration {
  readonly multiplier: number | null;
  /** `targetBenchmarkIndex`, recorded since #1370. */
  readonly target: number | null;
}

/** Whether two audits emulated the same device (see the file comment). */
function sameDevice(a: RecordedCalibration, b: RecordedCalibration): boolean {
  if (a.target !== null || b.target !== null) return a.target === b.target;
  return a.multiplier === b.multiplier;
}

/**
 * The previous scores a page's current scores may be compared with: all
 * of them, minus Performance when the two audits emulated a different
 * device (two audits without any calibration recorded are the same).
 */
export function comparablePreviousScores(
  previous: Readonly<Record<QualityCategory, number>>,
  previousCalibration: RecordedCalibration,
  currentCalibration: RecordedCalibration,
): Partial<Record<QualityCategory, number>> {
  if (sameDevice(previousCalibration, currentCalibration)) return { ...previous };
  const { performance: _differentDevice, ...rest } = previous;
  return rest;
}

function recorded(multiplier: string | null, target: string | null): RecordedCalibration {
  return {
    multiplier: multiplier === null ? null : Number(multiplier),
    target: target === null ? null : Number(target),
  };
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
           prev.metrics -> 'cpuCalibration' ->> 'targetBenchmarkIndex' AS previous_target,
           now_page.metrics -> 'cpuCalibration' ->> 'cpuSlowdownMultiplier' AS current_cpu,
           now_page.metrics -> 'cpuCalibration' ->> 'targetBenchmarkIndex' AS current_target
    FROM cur
    JOIN quality_audit_pages now_page ON now_page.audit_run_id = ${runId}::uuid
    JOIN quality_audit_pages prev ON prev.page_id = now_page.page_id
    JOIN quality_audit_runs q ON q.id = prev.audit_run_id
    LEFT JOIN chat_sessions cs ON cs.id = q.chat_session_id
    WHERE now_page.page_id = ANY(${uuidArray(pageIds)})
      AND q.created_at < cur.created_at
      AND cs.chat_branch_id IS NOT DISTINCT FROM cur.chat_branch_id
      AND prev.scores IS NOT NULL
    ORDER BY prev.page_id, q.created_at DESC
  `)) as unknown as {
    page_id: string;
    scores: unknown;
    previous_cpu: string | null;
    previous_target: string | null;
    current_cpu: string | null;
    current_target: string | null;
  }[];
  return new Map(
    rows.map((r) => [
      r.page_id,
      comparablePreviousScores(
        r.scores as Record<QualityCategory, number>,
        recorded(r.previous_cpu, r.previous_target),
        recorded(r.current_cpu, r.current_target),
      ),
    ]),
  );
}
