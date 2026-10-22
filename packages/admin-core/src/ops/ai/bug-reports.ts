// SPDX-License-Identifier: MPL-2.0

/**
 * `ai_bug_reports.*` — the AI's first-class defect channel.
 *
 * When the AI diagnoses a product bug mid-task (a tool behaving contrary
 * to its description, a render contradicting persisted state), it files a
 * report via the `bug_report` tool → `ai_bug_reports.create`, then keeps
 * working when a workaround exists. The rows are an info source (triage
 * via `ai_bug_reports.list`) AND a metric (reports-per-run in the e2e
 * metrics — a rising count is a regression signal even while the suite
 * stays green, because the AI is routing around defects, not failing).
 *
 * Every row carries a `forwardingState` (#902) saying where the report
 * went: `queued` when the Owner opted in to sending reports to the Caelo
 * team (bug_forwarding.set), otherwise `local_only`. The tool result says
 * which, instead of implying the Caelo team was told. The row also stores
 * its defect fingerprint (shared/bug-intake.ts) so the intake can merge the
 * same defect across installs.
 *
 * Not audited: internal AI telemetry, same stance as ai_moduleize_attempts.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { computeBugFingerprint, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const createBugReportInput = z
  .object({
    chatSessionId: z.string().uuid().nullable().optional(),
    title: z.string().min(1).max(200),
    whatHappened: z.string().min(1).max(4000),
    expected: z.string().min(1).max(4000),
    suspectedTool: z.string().max(200).nullable().optional(),
    evidence: z.string().max(8000).nullable().optional(),
    severity: z.enum(["blocking", "degraded", "cosmetic"]).default("degraded"),
    blockedTask: z.boolean().default(false),
    // 'ai' = the model filed it via the bug_report tool; 'auto' = the
    // chat-runner auto-captured a failed tool result. Default 'ai'.
    source: z.enum(["ai", "auto"]).default("ai"),
  })
  .strict();

/** Where a bug report went — see migration 0329 for the meaning of each state. */
export const bugForwardingState = z.enum(["local_only", "queued", "sent", "failed"]);
export type BugForwardingState = z.infer<typeof bugForwardingState>;

export const createBugReportOp = defineOperation({
  name: "ai_bug_reports.create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: createBugReportInput,
  output: z.object({ id: z.string(), forwardingState: bugForwardingState }),
  handler: async (ctx, input, tx) => {
    // Auto-captured reports dedupe within a session: the same tool failing with
    // the same message would otherwise file one row per retry. AI-filed reports
    // rely on the model's "report once per defect" contract instead.
    if (input.source === "auto" && input.chatSessionId) {
      const dup = (await tx.execute(sql`
        SELECT id::text AS id, forwarding_state AS "forwardingState" FROM ai_bug_reports
        WHERE source = 'auto'
          AND chat_session_id = ${input.chatSessionId}::uuid
          AND suspected_tool IS NOT DISTINCT FROM ${input.suspectedTool ?? null}
          AND what_happened = ${input.whatHappened}
          AND status IN ('new', 'triaged')
        LIMIT 1
      `)) as unknown as Array<{ id: string; forwardingState: BugForwardingState }>;
      if (dup[0]) return ok(dup[0]);
    }
    const fingerprint = await computeBugFingerprint({
      source: input.source,
      suspectedTool: input.suspectedTool ?? null,
      title: input.title,
      whatHappened: input.whatHappened,
    });
    const rows = (await tx.execute(sql`
      INSERT INTO ai_bug_reports
        (chat_session_id, actor_id, title, what_happened, expected,
         suspected_tool, evidence, severity, blocked_task, source,
         fingerprint, forwarding_state, next_forward_at)
      VALUES (
        ${input.chatSessionId ?? null}::uuid,
        ${ctx.actorId}::uuid,
        ${input.title},
        ${input.whatHappened},
        ${input.expected},
        ${input.suspectedTool ?? null},
        ${input.evidence ?? null},
        ${input.severity},
        ${input.blockedTask},
        ${input.source},
        ${fingerprint},
        CASE WHEN (SELECT bug_forwarding_enabled FROM telemetry_settings WHERE id = 1)
             THEN 'queued' ELSE 'local_only' END,
        CASE WHEN (SELECT bug_forwarding_enabled FROM telemetry_settings WHERE id = 1)
             THEN now() END
      )
      RETURNING id::text AS id, forwarding_state AS "forwardingState"
    `)) as unknown as Array<{ id: string; forwardingState: BugForwardingState }>;
    const row = rows[0];
    if (!row) throw new Error("ai_bug_reports INSERT returned no row");
    return ok(row);
  },
});

const listBugReportsInput = z
  .object({
    status: z.enum(["new", "triaged", "fixed", "invalid"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

const bugReportRow = z.object({
  id: z.string(),
  createdAt: z.string(),
  chatSessionId: z.string().nullable(),
  title: z.string(),
  whatHappened: z.string(),
  expected: z.string(),
  suspectedTool: z.string().nullable(),
  evidence: z.string().nullable(),
  severity: z.string(),
  blockedTask: z.boolean(),
  status: z.string(),
  /** 'ai' (model-filed via bug_report) or 'auto' (chat-runner auto-captured). */
  source: z.string(),
  forwardingState: bugForwardingState,
  /** Last send failure, shown so the Owner sees why a report did not go out. */
  forwardError: z.string().nullable(),
  /** Upstream state once sent: open | fixed | regression | wontfix. */
  upstreamStatus: z.string().nullable(),
  upstreamIssueUrl: z.string().nullable(),
  upstreamFixedIn: z.string().nullable(),
});

export const listBugReportsOp = defineOperation({
  name: "ai_bug_reports.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: listBugReportsInput,
  output: z.object({ reports: z.array(bugReportRow), total: z.number() }),
  handler: async (_ctx, input, tx) => {
    const where = input.status !== undefined ? sql`WHERE status = ${input.status}` : sql``;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id,
             created_at::text AS "createdAt",
             chat_session_id::text AS "chatSessionId",
             title,
             what_happened AS "whatHappened",
             expected,
             suspected_tool AS "suspectedTool",
             evidence,
             severity,
             blocked_task AS "blockedTask",
             status,
             source,
             forwarding_state AS "forwardingState",
             forward_error AS "forwardError",
             upstream_status AS "upstreamStatus",
             upstream_issue_url AS "upstreamIssueUrl",
             upstream_fixed_in AS "upstreamFixedIn",
             count(*) OVER ()::int AS total
      FROM ai_bug_reports
      ${where}
      ORDER BY created_at DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `)) as unknown as Array<z.infer<typeof bugReportRow> & { total: number }>;
    return ok({
      reports: rows.map(({ total: _t, ...r }) => r),
      total: rows[0]?.total ?? 0,
    });
  },
});
