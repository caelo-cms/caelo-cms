// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 3 — the quality gate for production builds that do NOT go
 * through deploy.promote: a direct `deploy.trigger` on a production target
 * (Ops "Deploy production", the automatic redeploy's content-only path).
 *
 * A production rebuild bakes main, and main holds everything that was
 * Staged — including a staged build the gate is still holding back. So a
 * direct production build is publishing live and gets the same rule:
 *
 *   - the gate of the current staged build is open → build;
 *   - the quality check FAILED (no result) → only with an explicit
 *     "publish anyway" by a human holding deploy.trigger, recorded on the
 *     audit run like the Publish-live override;
 *   - anything else (problems, a check still running, nothing staged or
 *     never checked) → refused with the next step.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { recordAudit } from "../../audit.js";
import { actorHasPermission } from "./_permissions.js";
import { latestSucceededRun, publishGateForRun } from "./gate-loader.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

export type ProductionGateResult =
  | { readonly ok: true; readonly overridden: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Decide whether a direct production build may run.
 *
 * @param publishAnyway - the caller's explicit decision to publish over a
 *   FAILED quality check, with its reason. Honoured only for a human with
 *   deploy.trigger; recorded on the audit run and in the audit trail.
 */
export async function checkProductionBuildGate(
  tx: Tx,
  ctx: ExecutionContext,
  publishAnyway: { readonly reason: string } | undefined,
): Promise<ProductionGateResult> {
  const staged = await latestSucceededRun(tx, "staging");
  if (!staged) {
    return {
      ok: false,
      message:
        "Production only ships builds that went through staging and its quality check, and nothing has been staged yet. Stage first, then Publish live.",
    };
  }
  const gate = await publishGateForRun(tx, staged.id);
  if (gate.open) return { ok: true, overridden: false };
  if (gate.state !== "errored" || !gate.auditRunId) {
    return {
      ok: false,
      message: `A production build would publish what is staged, so it waits for the quality gate. ${gate.message}`,
    };
  }
  if (!publishAnyway) {
    return {
      ok: false,
      message: `${gate.message} To build production anyway, an editor who may publish repeats it with a "publish anyway" reason.`,
    };
  }
  if (ctx.actorKind !== "human" || !(await actorHasPermission(tx, ctx, "deploy.trigger"))) {
    return {
      ok: false,
      message:
        "Publishing over a failed quality check is a human decision that needs the deploy.trigger permission.",
    };
  }
  await tx.execute(sql`
    UPDATE quality_audit_runs
       SET publish_override_by = ${ctx.actorId}::uuid,
           publish_override_reason = ${publishAnyway.reason},
           publish_override_at = now()
     WHERE id = ${gate.auditRunId}::uuid
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "quality_audits.publish_anyway",
    input: { auditRunId: gate.auditRunId, reason: publishAnyway.reason, via: "deploy.trigger" },
    succeeded: true,
    entityId: gate.auditRunId,
    resultSummary: `production build over a failed quality check: ${publishAnyway.reason}`,
  });
  return { ok: true, overridden: true };
}
