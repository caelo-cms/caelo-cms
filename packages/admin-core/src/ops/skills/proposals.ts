// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — skill proposals queue. AI calls `skills.propose` with a draft
 * body; Owner reviews + accepts (creating a `skills` row at
 * status='awaiting_activation') or rejects. Same pattern as
 * ai_memory_proposals (P5).
 *
 * Why a separate accept step + status='awaiting_activation': accepting
 * the proposal flags the body as Owner-approved, but the Owner can
 * THEN explicitly activate it (`skills.set` with status='active') so
 * editing is a deliberate site-wide decision (CLAUDE.md §2:
 * "Skill creation/updates follow the same preview → snapshot → confirm
 * path as any other AI change. New skills additionally require human
 * Owner activation").
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok, skillAutoEngagementHints } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const proposalRow = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  body: z.string(),
  rationale: z.string(),
  allowlistedTools: z.array(z.string()),
  hints: skillAutoEngagementHints,
  status: z.enum(["pending", "accepted", "rejected"]),
  proposedBy: z.string(),
  chatSessionId: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  resultingSkillId: z.string().nullable(),
  createdAt: z.string(),
});

interface ProposalDb {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  body: string;
  rationale: string;
  allowlisted_tools: unknown;
  auto_engagement_hints: unknown;
  status: "pending" | "accepted" | "rejected";
  proposed_by: string;
  chat_session_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | Date | null;
  decision_note: string | null;
  resulting_skill_id: string | null;
  created_at: string | Date;
}

function rowToOut(r: ProposalDb): z.infer<typeof proposalRow> {
  const hintsRaw =
    typeof r.auto_engagement_hints === "string"
      ? JSON.parse(r.auto_engagement_hints)
      : ((r.auto_engagement_hints as Record<string, unknown> | null) ?? {});
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    body: r.body,
    rationale: r.rationale,
    allowlistedTools: Array.isArray(r.allowlisted_tools)
      ? (r.allowlisted_tools as string[])
      : typeof r.allowlisted_tools === "string"
        ? (JSON.parse(r.allowlisted_tools) as string[])
        : [],
    hints: skillAutoEngagementHints.parse({
      keywords: (hintsRaw as { keywords?: unknown }).keywords ?? [],
      chipTrigger: (hintsRaw as { chipTrigger?: unknown }).chipTrigger ?? false,
      alwaysOn: (hintsRaw as { alwaysOn?: unknown }).alwaysOn ?? false,
    }),
    status: r.status,
    proposedBy: r.proposed_by,
    chatSessionId: r.chat_session_id,
    reviewedBy: r.reviewed_by,
    reviewedAt:
      r.reviewed_at === null
        ? null
        : r.reviewed_at instanceof Date
          ? r.reviewed_at.toISOString()
          : String(r.reviewed_at),
    decisionNote: r.decision_note,
    resultingSkillId: r.resulting_skill_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export const proposeSkillOp = defineOperation({
  name: "skills.propose",
  // CLAUDE.md §11.A pattern (similar to ai_memory.propose): AI proposes
  // a body; Owner clicks Accept/Reject in /security/skills/proposals.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9-]+$/, "lowercase letters/digits/hyphens"),
      displayName: z.string().min(1).max(200),
      description: z.string().max(1000).default(""),
      body: z.string().min(1).max(20000),
      rationale: z.string().min(1).max(1000),
      allowlistedTools: z.array(z.string().min(1).max(120)).default([]),
      hints: skillAutoEngagementHints.default({
        keywords: [],
        chipTrigger: false,
        alwaysOn: false,
      }),
      chatSessionId: z.string().uuid().nullable().optional(),
    })
    .strict(),
  output: z.object({ proposalId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO skill_proposals (proposed_by, chat_session_id, slug, display_name,
                                   description, body, rationale, allowlisted_tools,
                                   auto_engagement_hints)
      VALUES (
        ${ctx.actorId}::uuid, ${input.chatSessionId ?? null}, ${input.slug},
        ${input.displayName}, ${input.description}, ${input.body}, ${input.rationale},
        ${JSON.stringify(input.allowlistedTools)}::jsonb,
        ${JSON.stringify(input.hints)}::jsonb
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({ kind: "HandlerError", operation: "skills.propose", message: "no id returned" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "skills.propose",
      input,
      succeeded: true,
      entityId: proposalId,
      resultSummary: `slug=${input.slug}`,
    });
    return ok({ proposalId });
  },
});

export const listSkillProposalsOp = defineOperation({
  name: "skills.list_proposals",
  // CLAUDE.md §11.A: AI checks its own pending proposals when planning
  // — avoids re-proposing the same skill the Owner is reviewing.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      status: z.enum(["pending", "accepted", "rejected", "all"]).default("pending"),
    })
    .strict(),
  output: z.object({ proposals: z.array(proposalRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      input.status === "all"
        ? sql`
            SELECT id::text AS id, slug, display_name, description, body, rationale,
                   allowlisted_tools, auto_engagement_hints, status,
                   proposed_by::text AS proposed_by,
                   chat_session_id::text AS chat_session_id,
                   reviewed_by::text AS reviewed_by, reviewed_at, decision_note,
                   resulting_skill_id::text AS resulting_skill_id,
                   created_at
            FROM skill_proposals
            ORDER BY created_at DESC
            LIMIT 200
          `
        : sql`
            SELECT id::text AS id, slug, display_name, description, body, rationale,
                   allowlisted_tools, auto_engagement_hints, status,
                   proposed_by::text AS proposed_by,
                   chat_session_id::text AS chat_session_id,
                   reviewed_by::text AS reviewed_by, reviewed_at, decision_note,
                   resulting_skill_id::text AS resulting_skill_id,
                   created_at
            FROM skill_proposals
            WHERE status = ${input.status}
            ORDER BY created_at DESC
            LIMIT 200
          `,
    )) as unknown as ProposalDb[];
    return ok({ proposals: rows.map(rowToOut) });
  },
});

export const reviewSkillProposalOp = defineOperation({
  name: "skills.review_proposal",
  // Why human-only: accepting an AI-drafted skill body changes the
  // AI's instruction surface site-wide; Owner-only per CLAUDE.md §2.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      decision: z.enum(["accept", "reject"]),
      decisionNote: z.string().max(1000).optional(),
    })
    .strict(),
  output: z.object({ resultingSkillId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT slug, display_name, description, body, allowlisted_tools,
             auto_engagement_hints, status
      FROM skill_proposals WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as {
      slug: string;
      display_name: string;
      description: string;
      body: string;
      allowlisted_tools: unknown;
      auto_engagement_hints: unknown;
      status: "pending" | "accepted" | "rejected";
    }[];
    const proposal = rows[0];
    if (!proposal) {
      return err({
        kind: "HandlerError",
        operation: "skills.review_proposal",
        message: "proposal not found",
      });
    }
    if (proposal.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "skills.review_proposal",
        message: `proposal already ${proposal.status}`,
      });
    }
    let resultingSkillId: string | null = null;
    if (input.decision === "accept") {
      // Land the skill row at status='awaiting_activation' — Owner
      // explicitly activates separately so accept ≠ go-live.
      const allowlist =
        typeof proposal.allowlisted_tools === "string"
          ? proposal.allowlisted_tools
          : JSON.stringify(proposal.allowlisted_tools ?? []);
      const hints =
        typeof proposal.auto_engagement_hints === "string"
          ? proposal.auto_engagement_hints
          : JSON.stringify(proposal.auto_engagement_hints ?? {});
      const created = (await tx.execute(sql`
        INSERT INTO skills (slug, display_name, description, body,
                            allowlisted_tools, auto_engagement_hints,
                            status, proposed_by)
        VALUES (
          ${proposal.slug}, ${proposal.display_name}, ${proposal.description},
          ${proposal.body}, ${allowlist}::jsonb, ${hints}::jsonb,
          'awaiting_activation', ${ctx.actorId}::uuid
        )
        ON CONFLICT (slug) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          description = EXCLUDED.description,
          body = EXCLUDED.body,
          allowlisted_tools = EXCLUDED.allowlisted_tools,
          auto_engagement_hints = EXCLUDED.auto_engagement_hints,
          status = 'awaiting_activation',
          updated_at = now()
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      resultingSkillId = created[0]?.id ?? null;
    }
    await tx.execute(sql`
      UPDATE skill_proposals
      SET status = ${input.decision === "accept" ? "accepted" : "rejected"},
          reviewed_by = ${ctx.actorId}::uuid,
          reviewed_at = now(),
          decision_note = ${input.decisionNote ?? null},
          resulting_skill_id = ${resultingSkillId}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "skills.review_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `decision=${input.decision} skill_id=${resultingSkillId ?? "(none)"}`,
    });
    return ok({ resultingSkillId });
  },
});
