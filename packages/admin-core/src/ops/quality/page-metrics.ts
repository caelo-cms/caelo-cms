// SPDX-License-Identifier: MPL-2.0

/**
 * The last Lighthouse Performance metrics measured per page, read from
 * `quality_audit_pages.metrics` (0274). `check_stage_audit` shows them for
 * the pages a chat's next Stage touches, so an agent planning a speed fix
 * starts from the real staged numbers instead of running Lighthouse itself.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { performanceMetricsSchema } from "../../quality/lighthouse-protocol.js";
import { iso, uuidList } from "./_shared.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Pages reported at most (the homepage plus the touched pages). */
export const LAST_METRICS_PAGE_LIMIT = 10;

export const lastPageMetricsSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string(),
  pagePath: z.string(),
  /** The audit run that measured them. */
  auditRunId: z.string(),
  measuredAt: z.string(),
  metrics: performanceMetricsSchema,
});

export type LastPageMetrics = z.infer<typeof lastPageMetricsSchema>;

/**
 * The newest measured metrics of the given pages and of the homepage
 * (Lighthouse audits it on every run), homepage first, then by path.
 * Pages Lighthouse never audited are absent — there is nothing measured
 * to report for them.
 */
export async function lastPageMetrics(
  tx: Tx,
  pageIds: readonly string[],
): Promise<LastPageMetrics[]> {
  const rows = (await tx.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (qp.page_id)
             qp.page_id::text AS page_id, p.title, p.current_path,
             qp.audit_run_id::text AS audit_run_id, qp.created_at, qp.metrics
      FROM quality_audit_pages qp
      JOIN pages p ON p.id = qp.page_id
      WHERE qp.metrics IS NOT NULL AND p.deleted_at IS NULL
        AND (qp.page_id = ANY(${uuidList(pageIds)}) OR p.current_path = '/')
      ORDER BY qp.page_id, qp.created_at DESC
    ) latest
    ORDER BY (latest.current_path = '/') DESC, latest.current_path
    LIMIT ${LAST_METRICS_PAGE_LIMIT}
  `)) as unknown as {
    page_id: string;
    title: string;
    current_path: string;
    audit_run_id: string;
    created_at: string | Date;
    metrics: unknown;
  }[];
  return rows.map((r) => ({
    pageId: r.page_id,
    pageTitle: r.title,
    pagePath: r.current_path,
    auditRunId: r.audit_run_id,
    measuredAt: iso(r.created_at),
    metrics: r.metrics as LastPageMetrics["metrics"],
  }));
}
