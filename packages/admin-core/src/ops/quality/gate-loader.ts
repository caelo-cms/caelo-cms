// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — load what the Publish gate decides on: the newest audit of
 * a staging deploy run plus the live acceptances of its pages. Shared by
 * `deploy.promote` (the one choke point every Publish-live path runs
 * through, including the approval path that calls its handler directly)
 * and the gate read ops. Kept free of deploy imports so deploy.ts can use
 * it without an import cycle.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  decideGate,
  findingKey,
  type GateAudit,
  type GateDecision,
  scoreKey,
} from "../../quality/gate.js";
import type { QualityCategory, QualityProblem } from "../../quality/ratchet.js";
import { json, uuidList } from "./_shared.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** The newest audit of `deployRunId`, shaped for the gate (null = none). */
export async function loadGateAudit(tx: Tx, deployRunId: string): Promise<GateAudit | null> {
  const runs = (await tx.execute(sql`
    SELECT id::text AS id, status, error_code, error_message,
           publish_override_by::text AS publish_override_by, publish_override_reason
    FROM quality_audit_runs
    WHERE deploy_run_id = ${deployRunId}::uuid
    ORDER BY created_at DESC LIMIT 1
  `)) as unknown as {
    id: string;
    status: GateAudit["status"];
    error_code: string | null;
    error_message: string | null;
    publish_override_by: string | null;
    publish_override_reason: string | null;
  }[];
  const run = runs[0];
  if (!run) return null;
  const pages = (await tx.execute(sql`
    SELECT qp.page_id::text AS page_id, p.current_path, qp.problems
    FROM quality_audit_pages qp
    JOIN pages p ON p.id = qp.page_id AND p.deleted_at IS NULL
    WHERE qp.audit_run_id = ${run.id}::uuid
    ORDER BY (p.current_path = '/') DESC, p.current_path
  `)) as unknown as { page_id: string; current_path: string; problems: unknown }[];
  return {
    id: run.id,
    status: run.status,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    publishOverride:
      run.publish_override_by !== null
        ? { by: run.publish_override_by, reason: run.publish_override_reason ?? "" }
        : null,
    pages: pages.map((p) => ({
      pageId: p.page_id,
      pagePath: p.current_path,
      problems: json<QualityProblem[]>(p.problems),
    })),
  };
}

/** Live acceptances of the given pages, keyed for `decideGate`. */
export async function loadAcceptances(
  tx: Tx,
  pageIds: readonly string[],
): Promise<{ findings: Set<string>; scores: Map<string, number> }> {
  const findings = new Set<string>();
  const scores = new Map<string, number>();
  if (pageIds.length === 0) return { findings, scores };
  const rows = (await tx.execute(sql`
    SELECT page_id::text AS page_id, kind, audit_id, category, accepted_score
    FROM quality_acceptances
    WHERE revoked_at IS NULL
      AND page_id = ANY(${uuidList(pageIds)})
  `)) as unknown as {
    page_id: string;
    kind: "finding" | "score";
    audit_id: string | null;
    category: QualityCategory | null;
    accepted_score: number | null;
  }[];
  for (const r of rows) {
    if (r.kind === "finding" && r.audit_id) findings.add(findingKey(r.page_id, r.audit_id));
    if (r.kind === "score" && r.category && r.accepted_score !== null) {
      scores.set(scoreKey(r.page_id, r.category), r.accepted_score);
    }
  }
  return { findings, scores };
}

/** The gate decision for publishing `deployRunId`. */
export async function publishGateForRun(tx: Tx, deployRunId: string): Promise<GateDecision> {
  const audit = await loadGateAudit(tx, deployRunId);
  const acceptances = await loadAcceptances(tx, audit?.pages.map((p) => p.pageId) ?? []);
  return decideGate(audit, acceptances);
}

/** The newest succeeded deploy run of a target (what Publish would ship). */
export async function latestSucceededRun(
  tx: Tx,
  targetName: string,
): Promise<{ id: string; env: string } | null> {
  const rows = (await tx.execute(sql`
    SELECT r.id::text AS id, t.env
    FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
    WHERE t.name = ${targetName} AND r.status = 'succeeded' AND r.build_id IS NOT NULL
    ORDER BY r.started_at DESC LIMIT 1
  `)) as unknown as { id: string; env: string }[];
  return rows[0] ?? null;
}
