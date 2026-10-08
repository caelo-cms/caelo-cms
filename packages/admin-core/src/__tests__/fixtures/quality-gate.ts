// SPDX-License-Identifier: MPL-2.0
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { computeRenderFingerprint } from "../../ops/quality/render-fingerprint.js";
import { jsonbParam } from "../../sql-helpers.js";

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "fixture-open-quality-gate",
};

/**
 * #553 — production builds pass the quality gate of the current staged
 * build and must not ship rendering the Stage never saw. Suites that test
 * something else about production builds (output layout, rollback, …)
 * record a succeeded, quality-checked staging run of main AS IT IS NOW
 * (its render fingerprint), so the gate is open. Call it right before the
 * production build: a later staging build or a rendering change closes it.
 */
export async function openQualityGate(adapter: DatabaseAdapter): Promise<void> {
  await adapter.withAdminTransaction(SYSTEM, async (tx) => {
    const fingerprint = await computeRenderFingerprint(tx);
    const rows = (await tx.execute(sql`
      INSERT INTO deploy_runs (target_id, actor_id, status, finished_at, build_id, render_fingerprint)
      SELECT id, ${SYSTEM.actorId}::uuid, 'succeeded', now(), 'fixture-staged-build',
             ${jsonbParam(fingerprint)}
      FROM deploy_targets WHERE name = 'staging'
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const runId = rows[0]?.id;
    if (!runId) throw new Error("openQualityGate: no 'staging' deploy target");
    await tx.execute(sql`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${runId}::uuid, ${SYSTEM.actorId}::uuid, 'passed',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())
    `);
  });
}
