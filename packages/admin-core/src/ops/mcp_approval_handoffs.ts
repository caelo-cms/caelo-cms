// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — hand an approval decision back to the external agent that
 * asked for it.
 *
 * A Power-MCP caller (#376) that calls an approval-gated tool queues an
 * ordinary §11.A proposal in its domain's pending table. The operator
 * approves it wherever the card shows up — usually the Live Edit chat,
 * because the MCP resumes the operator's own session (#620). Two things
 * must follow from the click, and neither may be "the Live Edit AI starts
 * a turn":
 *
 *  1. The decision reaches the external agent (`mcp.get_approval_outcome`,
 *     which the MCP server polls while the agent's tool call waits).
 *  2. The chat that rendered the card knows the request came from outside
 *     (`requestedVia` on pending_proposals.list), so it reports the
 *     hand-back instead of auto-continuing its own AI.
 *
 * `mcp_approval_handoffs` (migration 0254) records the origin per
 * proposal. The proposal row stays the source of truth for the decision;
 * `resolveHandoffs` reads it and mirrors the first observed decision onto
 * the hand-off row — every approve/reject path (Live Edit strip, the
 * /settings/<domain>/pending pages, the cross-domain inbox) is therefore
 * covered without touching each domain's executor.
 */

import { defineOperation, type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { approverRefusal } from "./_approver-permission.js";

type Tx = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/** Decision states the external agent can receive. */
export const approvalOutcome = z.enum([
  "pending",
  "applied",
  "failed",
  "rejected",
  "superseded",
  "withdrawn",
]);
export type ApprovalOutcome = z.infer<typeof approvalOutcome>;

export const handoffView = z.object({
  proposalId: z.string(),
  domain: z.string(),
  channel: z.literal("power_mcp"),
  chatSessionId: z.string(),
  requestedBy: z.string(),
  toolName: z.string(),
  toolCallId: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  outcome: approvalOutcome,
  /** Operator's reason (reject) or the applied tool's result summary. */
  detail: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** When the external agent first read the decided outcome. */
  deliveredAt: z.string().nullable(),
});
export type HandoffView = z.infer<typeof handoffView>;

interface ProposalDecisionRow {
  domain: string;
  status: string;
  decided_at: string | Date | null;
  reason: string | null;
  result_ok: boolean | null;
  result_summary: string | null;
}

/**
 * Every pending-proposal source `pending_proposals.list` aggregates, read
 * by id regardless of status. Kept in step with that op's UNION (same
 * domain names) — a domain missing here means its MCP-originated
 * proposals never record a hand-off and the agent is told so.
 */
async function readProposalDecisions(tx: Tx, proposalId: string): Promise<ProposalDecisionRow[]> {
  const id = sql`${proposalId}::uuid`;
  return (await tx.execute(sql`
    SELECT 'deploy'::text AS domain, status::text AS status, decided_at, decision_reason AS reason,
           NULL::boolean AS result_ok, NULL::text AS result_summary
      FROM deploy_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'layouts', status, decided_at, decision_reason, NULL, NULL
      FROM layout_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'url_migrations', status, decided_at, decision_reason, NULL, NULL
      FROM url_migration_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'plugins', status, decided_at, decision_reason, NULL, NULL
      FROM plugin_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'users', status, decided_at, decision_reason, NULL, NULL
      FROM user_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'roles', status, decided_at, decision_reason, NULL, NULL
      FROM role_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'snapshots', status, decided_at, decision_reason, NULL, NULL
      FROM snapshot_revert_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'email_config', status, decided_at, decision_reason, NULL, NULL
      FROM email_config_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'ai_providers', status, decided_at, decision_reason, NULL, NULL
      FROM ai_providers_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'mcp_tokens', status, decided_at, decision_reason, NULL, NULL
      FROM mcp_token_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'templates', status, decided_at, decision_reason, NULL, NULL
      FROM template_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'domains', status, decided_at, decision_reason, NULL, NULL
      FROM domain_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'themes', status, decided_at, decision_reason, NULL, NULL
      FROM theme_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'site_defaults', status, decided_at, decision_reason, NULL, NULL
      FROM site_defaults_pending_actions WHERE id = ${id}
    -- #678: the next step computed when it was applied (e.g. "nothing is
    -- staged yet — Stage"), else the proposal's effect, rides back with
    -- 'applied'.
    UNION ALL SELECT 'owner_settings', status, decided_at, decision_reason, NULL,
                     COALESCE(preview->>'appliedNextStep', preview->>'effect')
      FROM owner_settings_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'quality', status, decided_at, decision_reason, NULL, NULL
      FROM quality_pending_actions WHERE id = ${id}
    UNION ALL SELECT 'tool_approvals', status, decided_at, decision_reason, result_ok, result_summary
      FROM tool_approval_actions WHERE id = ${id}
    UNION ALL SELECT 'gateway', status, decided_at, NULL, NULL, NULL
      FROM plugin_rate_limit_proposals WHERE id = ${id}
    UNION ALL SELECT 'site_memory', status, reviewed_at, NULL, NULL, NULL
      FROM site_memory_proposals WHERE id = ${id}
    UNION ALL SELECT 'skills', status, reviewed_at, NULL, NULL, NULL
      FROM skill_proposals WHERE id = ${id}
    -- import: approved_at is the approval evidence (execute_proposal sets
    -- it, reject_proposal does not); carried in result_ok to tell an
    -- Owner reject from a crawl that failed after approval.
    UNION ALL SELECT 'import', status, approved_at, error_message,
                     approved_at IS NOT NULL, NULL
      FROM import_runs WHERE id = ${id}
  `)) as unknown as ProposalDecisionRow[];
}

/**
 * Maps a proposal row's lifecycle onto what the external agent needs to
 * know. Pure — exported for the unit test.
 *
 * - `tool_approvals` flips to 'applied' BEFORE its tool dispatches (atomic
 *   claim), so an applied row without `result_ok` is still in flight.
 * - `import` has its own lifecycle: 'proposed' waits; 'failed' is an Owner
 *   reject when the run was never approved, else a crawl that failed after
 *   approval; any other state means the crawl was approved and started.
 */
export function decisionFromRow(row: ProposalDecisionRow): {
  outcome: ApprovalOutcome;
  detail: string | null;
} {
  if (row.domain === "import") {
    if (row.status === "proposed") return { outcome: "pending", detail: null };
    if (row.status === "failed") {
      // result_ok carries "approved_at IS NOT NULL" for imports.
      return row.result_ok
        ? { outcome: "failed", detail: row.reason }
        : { outcome: "rejected", detail: row.reason };
    }
    return { outcome: "applied", detail: `crawl approved (status: ${row.status})` };
  }
  switch (row.status) {
    case "pending":
      return { outcome: "pending", detail: null };
    case "applied":
    case "accepted":
      if (row.domain === "tool_approvals") {
        if (row.result_ok === null) return { outcome: "pending", detail: null };
        return {
          outcome: row.result_ok ? "applied" : "failed",
          detail: row.result_summary,
        };
      }
      // A domain that reports what the change means (owner_settings: the
      // proposal's effect) passes it on; the others select NULL.
      return { outcome: "applied", detail: row.result_summary };
    case "rejected":
      return { outcome: "rejected", detail: row.reason };
    case "superseded":
      return { outcome: "superseded", detail: row.reason };
    case "cancelled":
      return { outcome: "withdrawn", detail: row.reason };
    default:
      // A status this map does not know is schema drift (CLAUDE.md §2 —
      // no fallbacks): report it as still pending would hide it forever,
      // so name it.
      return { outcome: "failed", detail: `unknown proposal status '${row.status}'` };
  }
}

/** The domain a freshly queued proposal lives in, or null when no source has it. */
export async function locateProposalDomain(tx: Tx, proposalId: string): Promise<string | null> {
  const rows = await readProposalDecisions(tx, proposalId);
  return rows[0]?.domain ?? null;
}

interface HandoffRow {
  proposal_id: string;
  domain: string;
  channel: "power_mcp";
  chat_session_id: string;
  requested_by: string;
  tool_name: string;
  tool_call_id: string;
  summary: string;
  created_at: string | Date;
  outcome: Exclude<ApprovalOutcome, "pending"> | null;
  outcome_detail: string | null;
  decided_at: string | Date | null;
  delivered_at: string | Date | null;
}

const HANDOFF_COLUMNS = sql`
  proposal_id::text AS proposal_id, domain, channel,
  chat_session_id::text AS chat_session_id, requested_by::text AS requested_by,
  tool_name, tool_call_id, summary, created_at, outcome, outcome_detail,
  decided_at, delivered_at
`;

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toView(r: HandoffRow): HandoffView {
  return {
    proposalId: r.proposal_id,
    domain: r.domain,
    channel: r.channel,
    chatSessionId: r.chat_session_id,
    requestedBy: r.requested_by,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    summary: r.summary,
    createdAt: iso(r.created_at) ?? "",
    outcome: r.outcome ?? "pending",
    detail: r.outcome_detail,
    decidedAt: iso(r.decided_at),
    deliveredAt: iso(r.delivered_at),
  };
}

/**
 * Mirrors the proposal row's decision onto every still-undecided hand-off
 * in `rows` (first observation wins; a decided hand-off never changes).
 */
async function resolveHandoffs(tx: Tx, rows: HandoffRow[]): Promise<HandoffView[]> {
  const out: HandoffView[] = [];
  for (const row of rows) {
    if (row.outcome !== null) {
      out.push(toView(row));
      continue;
    }
    const sources = await readProposalDecisions(tx, row.proposal_id);
    const source = sources.find((s) => s.domain === row.domain);
    const decision = source
      ? decisionFromRow(source)
      : // The proposal row is gone (GC'd or deleted with its parent) — it
        // can no longer be applied, so the agent must not keep waiting.
        { outcome: "withdrawn" as const, detail: "the proposal no longer exists" };
    if (decision.outcome === "pending") {
      out.push(toView(row));
      continue;
    }
    const updated = (await tx.execute(sql`
      UPDATE mcp_approval_handoffs
         SET outcome = ${decision.outcome},
             outcome_detail = ${decision.detail},
             decided_at = COALESCE(${source?.decided_at ?? null}::timestamptz, now())
       WHERE proposal_id = ${row.proposal_id}::uuid AND outcome IS NULL
      RETURNING ${HANDOFF_COLUMNS}
    `)) as unknown as HandoffRow[];
    out.push(toView(updated[0] ?? row));
  }
  return out;
}

/**
 * Records an MCP-originated proposal right after the gated tool queued it.
 * Idempotent (a cached tool-call replay re-sends the same proposal id).
 * Returns null when the proposal is in no known source — the caller tells
 * the agent the hand-back is unavailable instead of pretending.
 */
export async function recordMcpHandoff(
  tx: Tx,
  input: {
    proposalId: string;
    chatSessionId: string;
    requestedBy: string;
    toolName: string;
    toolCallId: string;
    summary: string;
  },
): Promise<{ domain: string } | null> {
  const domain = await locateProposalDomain(tx, input.proposalId);
  if (!domain) return null;
  await tx.execute(sql`
    INSERT INTO mcp_approval_handoffs
      (proposal_id, domain, chat_session_id, requested_by, tool_name, tool_call_id, summary)
    VALUES
      (${input.proposalId}::uuid, ${domain}, ${input.chatSessionId}::uuid,
       ${input.requestedBy}::uuid, ${input.toolName}, ${input.toolCallId},
       ${input.summary.slice(0, 500)})
    ON CONFLICT (proposal_id) DO NOTHING
  `);
  return { domain };
}

/** The hand-off a (session, tool call) recorded — serves cached tool-call replays. */
export async function findMcpHandoffByToolCall(
  tx: Tx,
  chatSessionId: string,
  toolCallId: string,
): Promise<{ proposalId: string; domain: string } | null> {
  const rows = (await tx.execute(sql`
    SELECT proposal_id::text AS proposal_id, domain FROM mcp_approval_handoffs
     WHERE chat_session_id = ${chatSessionId}::uuid AND tool_call_id = ${toolCallId}
     ORDER BY created_at DESC LIMIT 1
  `)) as unknown as Array<{ proposal_id: string; domain: string }>;
  const row = rows[0];
  return row ? { proposalId: row.proposal_id, domain: row.domain } : null;
}

/**
 * The external agent's read of its own hand-off: resolves the decision and,
 * once decided, stamps `delivered_at` (first read) so the Live Edit card
 * can say the result reached the agent. Null when the proposal is not the
 * caller's (ownership is the token's actor — another user's hand-off reads
 * as not found).
 */
export async function readHandoffForAgent(
  tx: Tx,
  proposalId: string,
  requestedBy: string,
): Promise<HandoffView | null> {
  const rows = (await tx.execute(sql`
    SELECT ${HANDOFF_COLUMNS} FROM mcp_approval_handoffs
     WHERE proposal_id = ${proposalId}::uuid AND requested_by = ${requestedBy}::uuid
  `)) as unknown as HandoffRow[];
  if (rows.length === 0) return null;
  const [view] = await resolveHandoffs(tx, rows);
  if (!view || view.outcome === "pending" || view.deliveredAt !== null) return view ?? null;
  const stamped = (await tx.execute(sql`
    UPDATE mcp_approval_handoffs SET delivered_at = now()
     WHERE proposal_id = ${proposalId}::uuid AND delivered_at IS NULL
    RETURNING delivered_at
  `)) as unknown as Array<{ delivered_at: string | Date }>;
  return { ...view, deliveredAt: iso(stamped[0]?.delivered_at ?? null) };
}

// ─── mcp_approval_handoffs.list ──────────────────────────────────────

export const listMcpApprovalHandoffsOp = defineOperation({
  name: "mcp_approval_handoffs.list",
  readScope: "request",
  // Read surface — the Live Edit chat renders it, the AI may read it to
  // know which pending cards belong to an external agent.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid().optional(),
      proposalIds: z.array(z.string().uuid()).max(200).optional(),
      /** Only hand-offs created within this many hours (default 24). */
      withinHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .optional(),
    })
    .strict(),
  output: z.object({ handoffs: z.array(handoffView) }),
  handler: async (ctx, input, tx) => {
    const sessionFilter = input.chatSessionId
      ? sql`AND chat_session_id = ${input.chatSessionId}::uuid`
      : sql``;
    const idFilter =
      input.proposalIds && input.proposalIds.length > 0
        ? sql`AND proposal_id::text = ANY(${textArray(input.proposalIds)})`
        : sql``;
    let actorFilter = sql``;
    if (ctx.actorKind === "human") {
      const refusal = await approverRefusal(
        tx as TransactionRunner,
        ctx,
        "mcp_approval_handoffs.list",
        ["settings.write"],
      );
      if (refusal !== null) {
        actorFilter = sql`AND requested_by = ${ctx.actorId}::uuid`;
      }
    }
    const rows = (await tx.execute(sql`
      SELECT ${HANDOFF_COLUMNS} FROM mcp_approval_handoffs
       WHERE created_at > now() - make_interval(hours => ${input.withinHours ?? 24})
         ${sessionFilter} ${idFilter} ${actorFilter}
       ORDER BY created_at DESC
       LIMIT 200
    `)) as unknown as HandoffRow[];
    return ok({ handoffs: await resolveHandoffs(tx, rows) });
  },
});
