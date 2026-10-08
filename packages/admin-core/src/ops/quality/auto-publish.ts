// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 3 — the automatic redeploy goes through the quality gate.
 *
 *   quality_audits.plan_auto_redeploy    does main still render what the
 *                                        last Stage's check saw (render
 *                                        fingerprint)? Then production may
 *                                        be rebuilt directly (content only);
 *                                        otherwise Stage → audit → publish,
 *                                        auditing the pages the changes touch.
 *   quality_audits.settle_auto_publish   every automatic Stage whose audit
 *                                        ended — finished, failed, or
 *                                        interrupted by a restart — is
 *                                        published when the gate is open and
 *                                        it is still the newest Stage,
 *                                        otherwise stopped with the reason.
 *
 * Both are worker-internal (the redeploy orchestrator and the audit worker
 * run as `system`). A stop is recorded loudly: on the audit run
 * (`auto_publish_outcome = 'blocked'` + the gate message) and as a failed
 * production deploy run, which Ops and the notification bell surface like
 * a failed manual Publish.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { promoteDeployOp } from "../deploy.js";
import { latestSucceededRun, publishGateForRun } from "./gate-loader.js";
import { stagedRenderFingerprint, uncheckedRenderingSince } from "./render-fingerprint.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Candidate pages handed to `quality_audits.enqueue` (its input cap). */
const MAX_AUDIT_CANDIDATES = 50;

export const planAutoRedeployOp = defineOperation({
  name: "quality_audits.plan_auto_redeploy",
  // Why human-only: worker-internal — the redeploy orchestrator (system)
  // asks it before every automatic rebuild; the agent never redeploys.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      /** Pages the redeploy's own events named (audited after the pages
       *  the rendering changes touch). */
      changedPageIds: z.array(z.string().uuid()).max(500).default([]),
    })
    .strict(),
  output: z.object({
    auditNeeded: z.boolean(),
    reasons: z.array(z.string()),
    /** Audit candidates for the automatic Stage, most relevant first. */
    pageIds: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const staged = await latestSucceededRun(tx, "staging");
    const unchecked = staged
      ? await uncheckedRenderingSince(tx, await stagedRenderFingerprint(tx, staged.id))
      : { auditNeeded: true, reasons: ["nothing has been staged yet"], pageIds: [] };
    const pageIds = [...new Set([...unchecked.pageIds, ...input.changedPageIds])].slice(
      0,
      MAX_AUDIT_CANDIDATES,
    );
    return ok({ auditNeeded: unchecked.auditNeeded, reasons: [...unchecked.reasons], pageIds });
  },
});

const settledSchema = z.object({
  auditRunId: z.string(),
  outcome: z.enum(["published", "blocked"]),
  message: z.string().nullable(),
});
type Settled = z.infer<typeof settledSchema>;

async function block(
  tx: Tx,
  ctx: ExecutionContext,
  auditRunId: string,
  message: string,
): Promise<Settled> {
  await tx.execute(sql`
    UPDATE quality_audit_runs
       SET auto_publish_outcome = 'blocked', auto_publish_message = ${message}
     WHERE id = ${auditRunId}::uuid
  `);
  await tx.execute(sql`
    INSERT INTO deploy_runs (target_id, actor_id, status, finished_at, error_message)
    SELECT t.id, ${ctx.actorId}::uuid, 'failed', now(),
           ${`Automatic publish stopped by the quality gate: ${message}`}
    FROM deploy_targets t WHERE t.name = 'production'
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "quality_audits.settle_auto_publish",
    input: { auditRunId },
    succeeded: true,
    entityId: auditRunId,
    resultSummary: `blocked: ${message.slice(0, 200)}`,
  });
  return { auditRunId, outcome: "blocked", message };
}

/** Publish one ended automatic Stage, or stop it with the reason. */
async function settleOne(
  tx: Tx,
  ctx: ExecutionContext,
  run: { readonly id: string; readonly deploy_run_id: string },
): Promise<Settled> {
  const latest = await latestSucceededRun(tx, "staging");
  if (latest?.id !== run.deploy_run_id) {
    return block(
      tx,
      ctx,
      run.id,
      "a newer Stage replaced the automatically staged build before it could go live; that Stage's quality check decides now",
    );
  }
  const gate = await publishGateForRun(tx, run.deploy_run_id);
  if (!gate.open) return block(tx, ctx, run.id, gate.message);

  // Ship exactly the build this audit checked: promote refuses when a
  // newer Stage committed in the meantime.
  const promoted = await promoteDeployOp.handler(
    ctx,
    { fromTarget: "staging", toTarget: "production", expectedSourceRunId: run.deploy_run_id },
    tx,
  );
  if (!promoted.ok) {
    const reason = "message" in promoted.error ? promoted.error.message : promoted.error.kind;
    return block(tx, ctx, run.id, `the automatic publish failed: ${reason}`);
  }
  await tx.execute(sql`
    UPDATE quality_audit_runs SET auto_publish_outcome = 'published' WHERE id = ${run.id}::uuid
  `);
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: "quality_audits.settle_auto_publish",
    input: { auditRunId: run.id },
    succeeded: true,
    entityId: run.id,
    resultSummary: `published (production run ${promoted.value.toRunId})`,
  });
  return { auditRunId: run.id, outcome: "published", message: null };
}

export const settleAutoPublishOp = defineOperation({
  name: "quality_audits.settle_auto_publish",
  // Why human-only: worker-internal — the audit worker (system) settles
  // automatic Stages once their audits ended; publishing is gated here.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ settled: z.array(settledSchema) }),
  handler: async (ctx, _input, tx) => {
    // Every ended automatic run, however it ended: a finished audit, a
    // failed one, a run the stale sweep marked errored after a restart, or
    // one superseded while still queued. Oldest first, so only the newest
    // can still be published.
    const runs = (await tx.execute(sql`
      SELECT id::text AS id, deploy_run_id::text AS deploy_run_id
      FROM quality_audit_runs
      WHERE auto_publish AND auto_publish_outcome IS NULL
        AND status NOT IN ('queued', 'running')
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
    `)) as unknown as { id: string; deploy_run_id: string }[];
    const settled: Settled[] = [];
    for (const run of runs) settled.push(await settleOne(tx, ctx, run));
    return ok({ settled });
  },
});
