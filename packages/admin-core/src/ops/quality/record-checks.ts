// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the DB side of the findings checks' per-rule ratchet, used
 * by `quality_audits.record_result` (record-result.ts): load the live
 * check acceptances, tighten the ones fewer errors now undercut, and build
 * the run-level summary stored in `quality_audit_runs.checks`.
 */

import { type defineOperation, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { type CheckRuleProblem, tightenedAcceptances } from "../../quality/checks/evaluate.js";
import type { Finding } from "../../quality/checks/findings.js";
import type {
  CheckRunErrorRecord,
  ChecksOutcome,
  RunChecksSummary,
} from "../../quality/checks/outcome.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Live check acceptances of some pages plus the site-wide ones. */
export interface CheckAcceptances {
  /** rule id → accepted count, for a page (or `null` = site-wide). */
  counts(pageId: string | null): ReadonlyMap<string, number>;
  /** The acceptance row behind a page/site + rule. */
  idOf(pageId: string | null, ruleId: string): string | undefined;
}

/** Load the live `kind = 'check'` acceptances of the pages and the site. */
export async function loadCheckAcceptances(
  tx: Tx,
  pageIds: readonly string[],
): Promise<CheckAcceptances> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, page_id::text AS page_id, audit_id, accepted_count
    FROM quality_acceptances
    WHERE kind = 'check' AND revoked_at IS NULL
      AND (page_id IS NULL OR page_id = ANY(${uuidArray(pageIds)}))
  `)) as unknown as {
    id: string;
    page_id: string | null;
    audit_id: string;
    accepted_count: number;
  }[];
  const counts = new Map<string, Map<string, number>>();
  const ids = new Map<string, string>();
  for (const r of rows) {
    const key = r.page_id ?? "";
    let m = counts.get(key);
    if (!m) {
      m = new Map();
      counts.set(key, m);
    }
    m.set(r.audit_id, Number(r.accepted_count));
    ids.set(`${key}|${r.audit_id}`, r.id);
  }
  const empty: ReadonlyMap<string, number> = new Map();
  return {
    counts: (pageId) => counts.get(pageId ?? "") ?? empty,
    idOf: (pageId, ruleId) => ids.get(`${pageId ?? ""}|${ruleId}`),
  };
}

/**
 * The checks that really measured a page (`null` = the site-wide findings):
 * every check that ran, minus one that failed on that page or failed as a
 * whole. A page check measures nothing site-wide.
 */
export function measuredCheckIdsFor(checks: ChecksOutcome, pageId: string | null): Set<string> {
  const failed = new Set(
    checks.errors
      .filter((e) => e.checkId !== null && (e.pageId === undefined || e.pageId === pageId))
      .map((e) => e.checkId as string),
  );
  return new Set(
    checks.ran
      .filter((c) => !failed.has(c.id) && (pageId !== null || c.scope === "site"))
      .map((c) => c.id),
  );
}

/**
 * The ratchet's downward step: an accepted count above what was measured
 * now drops to the measurement; at 0 the acceptance is spent and revoked
 * (by the worker, as for a spent score acceptance). Only pages the checks
 * read move.
 */
export async function applyAcceptanceTightening(
  tx: Tx,
  actorId: string,
  args: {
    readonly accepted: CheckAcceptances;
    readonly checkedPageIds: readonly string[];
    readonly findingsByPage: ReadonlyMap<string, readonly Finding[]>;
    readonly siteFindings: readonly Finding[];
    readonly measured: (pageId: string | null) => ReadonlySet<string>;
  },
): Promise<void> {
  const scopes: (string | null)[] = [...args.checkedPageIds, null];
  for (const pageId of scopes) {
    const findings = pageId === null ? args.siteFindings : (args.findingsByPage.get(pageId) ?? []);
    const next = tightenedAcceptances(
      args.accepted.counts(pageId),
      findings,
      args.measured(pageId),
    );
    for (const [ruleId, count] of next) {
      const id = args.accepted.idOf(pageId, ruleId);
      if (!id) continue;
      if (count === 0) {
        await tx.execute(sql`
          UPDATE quality_acceptances SET revoked_at = now(), revoked_by = ${actorId}::uuid
          WHERE id = ${id}::uuid AND revoked_at IS NULL
        `);
      } else {
        await tx.execute(sql`
          UPDATE quality_acceptances SET accepted_count = ${count} WHERE id = ${id}::uuid
        `);
      }
    }
  }
}

/** The run-level summary stored in `quality_audit_runs.checks`. */
export function summarizeChecks(
  checks: ChecksOutcome,
  args: {
    readonly pagesChecked: number;
    readonly findings: readonly Finding[];
    readonly siteFindings: readonly Finding[];
    readonly siteProblems: readonly CheckRuleProblem[];
    readonly errors: readonly CheckRunErrorRecord[];
  },
): RunChecksSummary {
  const findingCounts = { error: 0, warning: 0, info: 0 };
  for (const f of args.findings) findingCounts[f.severity] += 1;
  return {
    ran: checks.ran,
    pagesChecked: args.pagesChecked,
    findingCounts,
    siteFindings: [...args.siteFindings],
    siteProblems: args.siteProblems.map((p) => ({ ...p, findings: [...p.findings] })),
    errors: [...args.errors],
  };
}
