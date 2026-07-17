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
 * Not audited: internal AI telemetry, same stance as ai_moduleize_attempts.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
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
  })
  .strict();

export const createBugReportOp = defineOperation({
  name: "ai_bug_reports.create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: createBugReportInput,
  output: z.object({ id: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO ai_bug_reports
        (chat_session_id, actor_id, title, what_happened, expected,
         suspected_tool, evidence, severity, blocked_task)
      VALUES (
        ${input.chatSessionId ?? null}::uuid,
        ${ctx.actorId}::uuid,
        ${input.title},
        ${input.whatHappened},
        ${input.expected},
        ${input.suspectedTool ?? null},
        ${input.evidence ?? null},
        ${input.severity},
        ${input.blockedTask}
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    return ok({ id: rows[0]?.id ?? "" });
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
