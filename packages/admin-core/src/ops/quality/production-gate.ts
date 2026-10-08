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
 *   - main changed since that Stage in a way its check did not see
 *     (render-fingerprint.ts: module code, templates, layouts, theme,
 *     plugins, pages going live) → refused: Stage again;
 *   - the gate of the current staged build is open → build;
 *   - the quality check FAILED (no result) → only with an explicit
 *     "publish anyway" by a human holding deploy.trigger. The override is
 *     recorded on the audit run only once the build succeeded
 *     (`recordProductionOverride`) — a failed build leaves the gate closed;
 *   - anything else (problems, a check still running, nothing staged or
 *     never checked) → refused with the next step.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { recordAudit } from "../../audit.js";
import { actorHasPermission } from "./_permissions.js";
import { latestSucceededRun, publishGateForRun } from "./gate-loader.js";
import { stagedRenderFingerprint, uncheckedRenderingSince } from "./render-fingerprint.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** A human's decision to build production over a FAILED quality check. */
export interface ProductionOverride {
  readonly auditRunId: string;
  readonly reason: string;
}

export type ProductionGateResult =
  | { readonly ok: true; readonly override: ProductionOverride | null }
  | { readonly ok: false; readonly message: string };

/**
 * Decide whether a direct production build may run. Writes nothing.
 *
 * @param publishAnyway - the caller's explicit decision to publish over a
 *   FAILED quality check, with its reason. Honoured only for a human with
 *   deploy.trigger; the caller records it after the build succeeded.
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
  const unchecked = await uncheckedRenderingSince(tx, await stagedRenderFingerprint(tx, staged.id));
  if (unchecked.auditNeeded) {
    return {
      ok: false,
      message: `The site changed since the last Stage in ways its quality check did not see (${unchecked.reasons.slice(0, 5).join("; ")}${unchecked.reasons.length > 5 ? "; …" : ""}). Stage again so the changes are checked, then Publish live.`,
    };
  }
  const gate = await publishGateForRun(tx, staged.id);
  if (gate.open) return { ok: true, override: null };
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
  return { ok: true, override: { auditRunId: gate.auditRunId, reason: publishAnyway.reason } };
}

/**
 * Record a publish-anyway override once the production build it allowed
 * has succeeded: on the audit run (the gate reads it) and in the audit
 * trail.
 */
export async function recordProductionOverride(
  tx: Tx,
  ctx: ExecutionContext,
  override: ProductionOverride,
): Promise<void> {
  await tx.execute(sql`
    UPDATE quality_audit_runs
       SET publish_override_by = ${ctx.actorId}::uuid,
           publish_override_reason = ${override.reason},
           publish_override_at = now()
     WHERE id = ${override.auditRunId}::uuid
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "quality_audits.publish_anyway",
    input: { auditRunId: override.auditRunId, reason: override.reason, via: "deploy.trigger" },
    succeeded: true,
    entityId: override.auditRunId,
    resultSummary: `production build over a failed quality check: ${override.reason}`,
  });
}
