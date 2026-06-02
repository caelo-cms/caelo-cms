// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.28 — templates.{propose_update, propose_delete,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * Same shape as role_pending (v0.2.22). templates.create and
 * templates.set_layout stay AI-direct; this gate covers the
 * higher-blast-radius update + delete paths.
 *
 * Preview surfaces:
 * - propose_update: count of pages bound to the template (re-render
 *   scope) + diff of which fields are being changed.
 * - propose_delete: count of pages that will be orphaned, plus the
 *   page slugs (capped at 50) so the Owner sees what fails first.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  err,
  ok,
  type ProposalStatus,
  proposalStatus,
  templateUpdateSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { deleteTemplateOp, updateTemplateOp } from "./templates.js";

// ─── propose_update ──────────────────────────────────────────────────

export const proposeTemplateUpdateOp = defineOperation({
  name: "templates.propose_update",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: templateUpdateSchema,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const meta = await loadTemplateMeta(tx, input.templateId);
    if (!meta) {
      return err({
        kind: "HandlerError",
        operation: "templates.propose_update",
        message: `template ${input.templateId} not found or deleted`,
      });
    }
    const changedFields = (
      ["displayName", "html", "css", "layoutId"] as const satisfies readonly (keyof typeof input)[]
    ).filter((k) => input[k] !== undefined);
    const preview = {
      kind: "update",
      templateId: meta.id,
      templateSlug: meta.slug,
      currentDisplayName: meta.display_name,
      changedFields,
      // Reverting a template re-renders every page bound to it.
      affectedPageCount: meta.bound_page_count,
    };
    return queueProposal(
      tx,
      ctx,
      "update",
      input.templateId,
      input,
      preview,
      "templates.propose_update",
    );
  },
});

// ─── propose_delete ──────────────────────────────────────────────────

const proposeDeleteInput = z.object({ templateId: z.string().uuid() }).strict();

export const proposeTemplateDeleteOp = defineOperation({
  name: "templates.propose_delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeDeleteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const meta = await loadTemplateMeta(tx, input.templateId);
    if (!meta) {
      return err({
        kind: "HandlerError",
        operation: "templates.propose_delete",
        message: `template ${input.templateId} not found or already deleted`,
      });
    }
    // Sample bound pages so the Owner sees what fails first.
    const sample = (await tx.execute(sql`
      SELECT slug, title FROM pages
      WHERE template_id = ${input.templateId}::uuid AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50
    `)) as unknown as Array<{ slug: string; title: string }>;
    const preview = {
      kind: "delete",
      templateId: meta.id,
      templateSlug: meta.slug,
      currentDisplayName: meta.display_name,
      affectedPageCount: meta.bound_page_count,
      sampleAffectedPages: sample.map((s) => ({ slug: s.slug, title: s.title })),
    };
    return queueProposal(
      tx,
      ctx,
      "delete",
      input.templateId,
      input,
      preview,
      "templates.propose_delete",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeTemplateProposalOp = defineOperation({
  name: "templates.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ templateId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, template_id::text AS template_id, payload, status
      FROM template_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "update" | "delete";
      template_id: string;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "templates.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "templates.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as Record<string, unknown>;
    if (row.kind === "update") {
      const r = await updateTemplateOp.handler(
        ctx,
        payload as Parameters<typeof updateTemplateOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "update");
    } else if (row.kind === "delete") {
      const r = await deleteTemplateOp.handler(
        ctx,
        payload as Parameters<typeof deleteTemplateOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "delete");
    }
    await tx.execute(sql`
      UPDATE template_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (templateId=${row.template_id})`,
    });
    return ok({ templateId: row.template_id });
  },
});

export const rejectTemplateProposalOp = defineOperation({
  name: "templates.reject_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE template_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

const proposalRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["update", "delete"]),
  proposedBy: z.string(),
  templateId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingTemplateProposalsOp = defineOperation({
  name: "templates.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 50;
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id, kind, proposed_by::text AS proposed_by,
        template_id::text AS template_id, payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM template_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "update" | "delete";
      proposed_by: string;
      template_id: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
      decided_at: string | Date | null;
      decided_by: string | null;
      decision_reason: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        templateId: r.template_id,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        decidedAt: r.decided_at
          ? r.decided_at instanceof Date
            ? r.decided_at.toISOString()
            : String(r.decided_at)
          : null,
        decidedBy: r.decided_by,
        decisionReason: r.decision_reason,
      })),
    });
  },
});

// ─── helpers ─────────────────────────────────────────────────────────

interface TemplateMeta {
  id: string;
  slug: string;
  display_name: string;
  bound_page_count: number;
}

async function loadTemplateMeta(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  templateId: string,
): Promise<TemplateMeta | null> {
  const rows = (await tx.execute(sql`
    SELECT t.id::text AS id, t.slug, t.display_name,
      (SELECT count(*)::int FROM pages
        WHERE template_id = t.id AND deleted_at IS NULL) AS bound_page_count
    FROM templates t
    WHERE t.id = ${templateId}::uuid AND t.deleted_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    slug: string;
    display_name: string;
    bound_page_count: number;
  }>;
  return rows[0] ?? null;
}

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "update" | "delete",
  templateId: string,
  payload: unknown,
  preview: unknown,
  opName: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload(payload);
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO template_pending_actions
        (kind, proposed_by, template_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${templateId}::uuid,
        ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify(preview)}::jsonb,
        'pending',
        ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
        ${payloadHash}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
  } catch (e) {
    if (isDuplicatePendingError(e)) {
      return err({ kind: "HandlerError", operation: opName, message: DUPLICATE_PROPOSAL_MESSAGE });
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return err({ kind: "HandlerError", operation: opName, message: "insert returned no id" });
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: `kind=${kind}`,
  });
  return ok({ proposalId, preview: preview as Record<string, unknown> });
}

function passthroughError(
  error: unknown,
  kind: string,
): {
  ok: false;
  error: { kind: "HandlerError"; operation: string; message: string };
} {
  const msg =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "unknown";
  return err({
    kind: "HandlerError",
    operation: "templates.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}
