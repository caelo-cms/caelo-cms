// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1721 — a running Stage audit for a test, and a plugin's audit
 * calls the way its job makes them: each call parsed as the admin parses
 * a `plugin-findings` report (`auditPluginCallSchema`, after a JSON round
 * trip like the transport's) and answered by the admin's own handler,
 * which adds the deploy run and, on a batch call with its own pages, the
 * audit run the plugin reads the other pages by. What a self-hosted admin
 * does with the job's reports, minus the lease and the token.
 */

import type { PluginAuditFindingsArgs } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { auditPluginCallSchema } from "../../quality/audit-job-wire.js";
import { qualityAuditJobKind } from "../../quality/audit-job-kind.js";
import type { PluginAuditAnswer, PluginAuditCall } from "../../quality/checks/plugin-findings.js";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

/** One `plugin-findings` report a {@link RunningAudit} answered. */
export interface AuditReportSent {
  readonly label: string;
  /** The report's payload as the job sends it (JSON characters). */
  readonly chars: number;
  readonly args: PluginAuditFindingsArgs;
}

/** A queued-and-claimed audit run of a staging build of its own. */
export interface RunningAudit {
  readonly auditRunId: string;
  readonly deployRunId: string;
  /** Every report the calls of {@link call} sent, in order. */
  readonly reports: AuditReportSent[];
  /** Plugin `slug`'s audit calls through the admin's `plugin-findings` handler. */
  call(slug: string): PluginAuditCall;
  /** End the run (`passed`): its handle is dead from then on. */
  end(): Promise<void>;
  /** Delete the run, its deploy run and its target. */
  remove(): Promise<void>;
}

async function asSystem<T>(url: string, fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

/**
 * Start a running audit named after `prefix` (the deploy target's name).
 *
 * @param adminUrl the cms_admin URL the rows are written with.
 */
export async function startRunningAudit(
  adminUrl: string,
  deps: { readonly adapter: DatabaseAdapter; readonly registry: OperationRegistry },
  prefix: string,
): Promise<RunningAudit> {
  const target = `${prefix}-audit-staging`;
  const ids = await asSystem(adminUrl, async (tx) => {
    const t = (await tx`INSERT INTO deploy_targets (name, env, out_dir)
      VALUES (${target}, 'staging', '/tmp/caelo-running-audit') RETURNING id::text AS id`) as {
      id: string;
    }[];
    const r = (await tx`INSERT INTO deploy_runs (target_id, actor_id, status)
      VALUES (${t[0]?.id}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded') RETURNING id::text AS id`) as {
      id: string;
    }[];
    const a =
      (await tx`INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, started_at)
      VALUES (${r[0]?.id}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'running',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())
      RETURNING id::text AS id`) as { id: string }[];
    return { deployRunId: r[0]?.id as string, auditRunId: a[0]?.id as string };
  });
  const reports: AuditReportSent[] = [];
  const handler = qualityAuditJobKind.actions["plugin-findings"];
  if (!handler) throw new Error("the quality audit's kind answers no plugin-findings report");
  return {
    ...ids,
    reports,
    call: (slug) => async (args, label) => {
      const text = JSON.stringify({ slug, label, args });
      reports.push({ label, chars: text.length, args });
      const input = auditPluginCallSchema.parse(JSON.parse(text));
      const answer = await handler.handle(deps, ids.auditRunId, input, {
        helperId: null,
        attempt: 1,
      });
      return answer.value as PluginAuditAnswer;
    },
    end: () =>
      asSystem(adminUrl, async (tx) => {
        await tx`UPDATE quality_audit_runs SET status = 'passed', finished_at = now()
                 WHERE id = ${ids.auditRunId}::uuid`;
      }),
    remove: () =>
      asSystem(adminUrl, async (tx) => {
        await tx`DELETE FROM quality_audit_runs WHERE id = ${ids.auditRunId}::uuid`;
        await tx`DELETE FROM deploy_runs WHERE id = ${ids.deployRunId}::uuid`;
        await tx`DELETE FROM deploy_targets WHERE name = ${target}`;
      }),
  };
}
