// SPDX-License-Identifier: MPL-2.0
import { SQL } from "bun";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";

/**
 * #553 — production builds pass the quality gate of the current staged
 * build. Suites that test something else about production builds (output
 * layout, rollback, …) record a succeeded, quality-checked staging run so
 * the gate is open. Call it right before the production build: a later
 * staging build replaces the run the gate looks at.
 */
export async function openQualityGate(adminUrl: string): Promise<void> {
  const sql = new SQL(adminUrl);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx`
        INSERT INTO deploy_runs (target_id, actor_id, status, finished_at, build_id)
        SELECT id, ${SYSTEM_ACTOR}::uuid, 'succeeded', now(), 'fixture-staged-build'
        FROM deploy_targets WHERE name = 'staging'
        RETURNING id::text AS id`;
      const runId = (rows[0] as { id: string } | undefined)?.id;
      if (!runId) throw new Error("openQualityGate: no 'staging' deploy target");
      await tx`
        INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
        VALUES (${runId}::uuid, ${SYSTEM_ACTOR}::uuid, 'passed',
                '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
    });
  } finally {
    await sql.end();
  }
}
