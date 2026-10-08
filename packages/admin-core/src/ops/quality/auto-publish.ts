// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 3 — the automatic redeploy goes through the quality gate.
 *
 *   quality_audits.plan_auto_redeploy     does this redeploy need the
 *                                         Stage → audit → publish path, or
 *                                         may it rebuild production directly
 *                                         (content only)?
 *   quality_audits.complete_auto_publish  after the worker recorded the
 *                                         audit of an automatic Stage:
 *                                         publish when the gate is open,
 *                                         otherwise stop and say why.
 *
 * Both are worker-internal (the redeploy orchestrator and the audit worker
 * run as `system`). A stop is recorded loudly: on the audit run
 * (`auto_publish_outcome = 'blocked'` + the gate message) and as a failed
 * production deploy run, which Ops and the notification bell surface like
 * a failed manual Publish.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { classifyRedeployOperations } from "../../quality/classify.js";
import { promoteDeployOp } from "../deploy.js";
import { uuidList } from "./_shared.js";
import { latestSucceededRun, publishGateForRun } from "./gate-loader.js";

export const planAutoRedeployOp = defineOperation({
  name: "quality_audits.plan_auto_redeploy",
  // Why human-only: worker-internal — the redeploy orchestrator (system)
  // asks it before every automatic rebuild; the agent never redeploys.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      operations: z.array(z.string().min(1).max(200)).max(500),
      changedPageIds: z.array(z.string().uuid()).max(500).default([]),
    })
    .strict(),
  output: z.object({ auditNeeded: z.boolean(), reasons: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    // A changed page that is published now but was created after the last
    // production build is going live for the first time — a new page.
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM pages p
      WHERE p.id = ANY(${uuidList(input.changedPageIds)})
        AND p.status = 'published' AND p.deleted_at IS NULL
        AND p.created_at > COALESCE((
          SELECT max(r.started_at) FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
          WHERE t.env = 'production' AND r.status = 'succeeded'
        ), '-infinity'::timestamptz)
    `)) as unknown as { n: number }[];
    const plan = classifyRedeployOperations(input.operations, rows[0]?.n ?? 0);
    return ok({ auditNeeded: plan.auditNeeded, reasons: [...plan.reasons] });
  },
});

const outcomeSchema = z.enum(["published", "blocked", "pending", "not_automatic"]);

export const completeAutoPublishOp = defineOperation({
  name: "quality_audits.complete_auto_publish",
  // Why human-only: worker-internal — the audit worker (system) settles an
  // automatic Stage once its audit is recorded; publishing is gated here.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ auditRunId: z.string().uuid() }).strict(),
  output: z.object({ outcome: outcomeSchema, message: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT deploy_run_id::text AS deploy_run_id, status, auto_publish, auto_publish_outcome
      FROM quality_audit_runs WHERE id = ${input.auditRunId}::uuid FOR UPDATE
    `)) as unknown as {
      deploy_run_id: string;
      status: string;
      auto_publish: boolean;
      auto_publish_outcome: "published" | "blocked" | null;
    }[];
    const run = rows[0];
    if (!run) {
      return err({
        kind: "HandlerError",
        operation: "quality_audits.complete_auto_publish",
        message: `audit run ${input.auditRunId} not found`,
      });
    }
    if (!run.auto_publish) return ok({ outcome: "not_automatic" as const, message: null });
    if (run.auto_publish_outcome) {
      return ok({ outcome: run.auto_publish_outcome, message: null });
    }
    if (run.status === "queued" || run.status === "running") {
      return ok({ outcome: "pending" as const, message: null });
    }

    const block = async (message: string, recordFailedRun = true) => {
      await tx.execute(sql`
        UPDATE quality_audit_runs
           SET auto_publish_outcome = 'blocked', auto_publish_message = ${message}
         WHERE id = ${input.auditRunId}::uuid
      `);
      if (recordFailedRun) {
        await tx.execute(sql`
          INSERT INTO deploy_runs (target_id, actor_id, status, finished_at, error_message)
          SELECT t.id, ${ctx.actorId}::uuid, 'failed', now(),
                 ${`Automatic publish stopped by the quality gate: ${message}`}
          FROM deploy_targets t WHERE t.name = 'production'
        `);
      }
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "quality_audits.complete_auto_publish",
        input,
        succeeded: true,
        entityId: input.auditRunId,
        resultSummary: `blocked: ${message.slice(0, 200)}`,
      });
      return ok({ outcome: "blocked" as const, message });
    };

    const latest = await latestSucceededRun(tx, "staging");
    if (latest?.id !== run.deploy_run_id) {
      return block(
        "a newer Stage replaced the automatically staged build before it could go live; that Stage's quality check decides now",
      );
    }
    const gate = await publishGateForRun(tx, run.deploy_run_id);
    if (!gate.open) return block(gate.message);

    const promoted = await promoteDeployOp.handler(
      ctx,
      { fromTarget: "staging", toTarget: "production" },
      tx,
    );
    if (!promoted.ok) {
      const reason = "message" in promoted.error ? promoted.error.message : promoted.error.kind;
      // promote already recorded its own failed production run.
      return block(`the automatic publish failed: ${reason}`, false);
    }
    await tx.execute(sql`
      UPDATE quality_audit_runs SET auto_publish_outcome = 'published'
      WHERE id = ${input.auditRunId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_audits.complete_auto_publish",
      input,
      succeeded: true,
      entityId: input.auditRunId,
      resultSummary: `published (production run ${promoted.value.toRunId})`,
    });
    return ok({ outcome: "published" as const, message: null });
  },
});
