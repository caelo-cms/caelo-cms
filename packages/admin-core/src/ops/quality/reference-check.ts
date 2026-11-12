// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1594 — the link check a Stage's quality audit reports.
 *
 * `deploy.start_trigger` runs the reference check where every build starts
 * (`buildReferenceGate`) and, for a staging build, records the same read
 * under the Publish policy on the run (`deploy_runs.reference_check`). The
 * audit's `references` and `links` checks read that record: they judge the
 * links of the state the build rendered, and a Stage reads the whole site
 * for its links twice (merge and build) instead of four times.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordedReferenceCheckSchema } from "../content/link-integrity.js";

export const auditReferenceCheckOp = defineOperation({
  name: "quality_audits.reference_check",
  readScope: "request",
  // Why human-only: job-internal — the quality audit's job reads the link
  // check of the build it audits (#1594, quality/audit-job-kind.ts); the AI
  // reads links with check_links (links.check_references).
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ auditRunId: z.string().uuid() }).strict(),
  output: recordedReferenceCheckSchema,
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT q.deploy_run_id::text AS deploy_run_id, r.reference_check
      FROM quality_audit_runs q
      JOIN deploy_runs r ON r.id = q.deploy_run_id
      WHERE q.id = ${input.auditRunId}::uuid
    `)) as unknown as { deploy_run_id: string; reference_check: unknown }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.reference_check",
        message: `quality audit ${input.auditRunId} does not exist (its Stage's build run was deleted). Stage again.`,
      });
    }
    const recorded = recordedReferenceCheckSchema.safeParse(row.reference_check);
    if (!recorded.success) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.reference_check",
        message:
          row.reference_check === null
            ? `staged build ${row.deploy_run_id} recorded no link check (it was staged by a release before #1594), so its audit cannot report the links it rendered. Stage again.`
            : `staged build ${row.deploy_run_id} recorded a link check this release cannot read (${recorded.error.message}). Stage again.`,
      });
    }
    return ok(recorded.data);
  },
});
