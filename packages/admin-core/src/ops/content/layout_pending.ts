// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.20 — layouts.{propose_create, propose_update, propose_delete,
 * propose_set_blocks, execute_proposal, reject_proposal, list_pending}.
 *
 * Same shape as deploy_pending (v0.2.19) — AI proposes the change with
 * a computed preview (affected templates / pages, slug); operator
 * clicks Approve at /security/layouts/pending which calls
 * `layouts.execute_proposal` (human-only) to run the underlying op.
 *
 * Why layouts get the gate: site-wide chrome. Update/delete/set_blocks
 * cascade across every page on every template bound to the layout.
 * Even create is gated because new layouts are infrequent + Owner-
 * curated; AI typically proposes in response to "make a campaign
 * layout" intent.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "../_propose-helpers.js";
import { createLayoutOp, deleteLayoutOp, setLayoutBlocksOp, updateLayoutOp } from "./layouts.js";

const layoutBlockShape = z.object({
  name: z.string().min(1).max(80),
  displayName: z.string().min(1).max(200),
  position: z.number().int().min(0).max(1000),
});

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

// ─── propose_create ──────────────────────────────────────────────────

const proposeCreateInput = z
  .object({
    slug: slugSchema,
    displayName: z.string().min(1).max(200),
    html: z.string().min(1).max(50_000),
    css: z.string().max(50_000).optional(),
    blocks: z.array(layoutBlockShape).min(1).max(20),
  })
  .strict();

export const proposeLayoutCreateOp = defineOperation({
  name: "layouts.propose_create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeCreateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    // Pre-flight: slug must be free.
    const dup = (await tx.execute(sql`
      SELECT 1 FROM layouts WHERE slug = ${input.slug} AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      return err({
        kind: "HandlerError",
        operation: "layouts.propose_create",
        message: `layout slug "${input.slug}" already in use`,
      });
    }
    const preview = {
      slug: input.slug,
      displayName: input.displayName,
      blockCount: input.blocks.length,
      blockNames: input.blocks.map((b) => b.name),
    };
    return queueProposal(tx, ctx, "create", null, input, preview, "layouts.propose_create");
  },
});

// ─── propose_update ──────────────────────────────────────────────────

const proposeUpdateInput = z
  .object({
    layoutId: z.string().uuid(),
    displayName: z.string().min(1).max(200).optional(),
    html: z.string().min(1).max(50_000).optional(),
    css: z.string().max(50_000).optional(),
  })
  .strict();

export const proposeLayoutUpdateOp = defineOperation({
  name: "layouts.propose_update",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeUpdateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const preview = await computeLayoutBlastRadius(tx, input.layoutId);
    if ("error" in preview) return preview.error;
    return queueProposal(
      tx,
      ctx,
      "update",
      input.layoutId,
      input,
      preview.value,
      "layouts.propose_update",
    );
  },
});

// ─── propose_delete ──────────────────────────────────────────────────

const proposeDeleteInput = z.object({ layoutId: z.string().uuid() }).strict();

export const proposeLayoutDeleteOp = defineOperation({
  name: "layouts.propose_delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeDeleteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const preview = await computeLayoutBlastRadius(tx, input.layoutId);
    if ("error" in preview) return preview.error;
    // Layouts referenced by templates can't be deleted (FK guard); the
    // execute will fail with a clear error, but we surface the conflict
    // at propose time so the Owner sees it before approving.
    if (preview.value.boundTemplateCount > 0) {
      return err({
        kind: "HandlerError",
        operation: "layouts.propose_delete",
        message: `layout "${preview.value.slug}" is bound by ${preview.value.boundTemplateCount} template(s) — re-point templates first via set_template_layout`,
      });
    }
    return queueProposal(
      tx,
      ctx,
      "delete",
      input.layoutId,
      input,
      preview.value,
      "layouts.propose_delete",
    );
  },
});

// ─── propose_set_blocks ──────────────────────────────────────────────

const proposeSetBlocksInput = z
  .object({
    layoutId: z.string().uuid(),
    blocks: z.array(layoutBlockShape).min(1).max(20),
  })
  .strict()
  .refine((v) => v.blocks.some((b) => b.name === "content"), {
    message: "blocks must include a `content` entry",
    path: ["blocks"],
  });

export const proposeLayoutSetBlocksOp = defineOperation({
  name: "layouts.propose_set_blocks",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeSetBlocksInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const radius = await computeLayoutBlastRadius(tx, input.layoutId);
    if ("error" in radius) return radius.error;
    const preview = {
      ...radius.value,
      newBlockCount: input.blocks.length,
      newBlockNames: input.blocks.map((b) => b.name),
    };
    return queueProposal(
      tx,
      ctx,
      "set_blocks",
      input.layoutId,
      input,
      preview,
      "layouts.propose_set_blocks",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeLayoutProposalOp = defineOperation({
  name: "layouts.execute_proposal",
  // human-only by design: this is the "Go button" half.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ layoutId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, layout_id::text AS layout_id, payload, status
      FROM layout_pending_actions
      WHERE id = ${input.proposalId}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "update" | "delete" | "set_blocks";
      layout_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "layouts.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "layouts.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as Record<string, unknown>;
    let resultLayoutId: string | null = row.layout_id;
    if (row.kind === "create") {
      const r = await createLayoutOp.handler(
        ctx,
        payload as Parameters<typeof createLayoutOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "create");
      resultLayoutId = (r.value as { layoutId: string }).layoutId;
    } else if (row.kind === "update") {
      const r = await updateLayoutOp.handler(
        ctx,
        payload as Parameters<typeof updateLayoutOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "update");
    } else if (row.kind === "delete") {
      const r = await deleteLayoutOp.handler(
        ctx,
        payload as Parameters<typeof deleteLayoutOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "delete");
    } else if (row.kind === "set_blocks") {
      const r = await setLayoutBlocksOp.handler(
        ctx,
        payload as Parameters<typeof setLayoutBlocksOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "set_blocks");
    }
    await tx.execute(sql`
      UPDATE layout_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_layout_id = ${resultLayoutId === null ? null : sql`${resultLayoutId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "layouts.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} applied (layoutId=${resultLayoutId ?? "(none)"})`,
    });
    return ok({ layoutId: resultLayoutId });
  },
});

export const rejectLayoutProposalOp = defineOperation({
  name: "layouts.reject_proposal",
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
      UPDATE layout_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "layouts.reject_proposal",
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
  kind: z.enum(["create", "update", "delete", "set_blocks"]),
  proposedBy: z.string(),
  layoutId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingLayoutProposalsOp = defineOperation({
  name: "layouts.list_pending",
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
        id::text                  AS id,
        kind,
        proposed_by::text         AS proposed_by,
        layout_id::text           AS layout_id,
        payload,
        preview,
        status,
        created_at,
        decided_at,
        decided_by::text          AS decided_by,
        decision_reason
      FROM layout_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "create" | "update" | "delete" | "set_blocks";
      proposed_by: string;
      layout_id: string | null;
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
        layoutId: r.layout_id,
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

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "create" | "update" | "delete" | "set_blocks",
  layoutId: string | null,
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
      INSERT INTO layout_pending_actions
        (kind, proposed_by, layout_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${layoutId === null ? null : sql`${layoutId}::uuid`},
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

interface BlastRadius {
  layoutId: string;
  slug: string;
  displayName: string;
  boundTemplateCount: number;
  affectedPageCount: number;
}

async function computeLayoutBlastRadius(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  layoutId: string,
): Promise<
  | { value: BlastRadius }
  | { error: { ok: false; error: { kind: "HandlerError"; operation: string; message: string } } }
> {
  const rows = (await tx.execute(sql`
    SELECT
      l.id::text             AS layout_id,
      l.slug                  AS slug,
      l.display_name          AS display_name,
      COUNT(DISTINCT t.id)    AS template_count,
      COUNT(DISTINCT p.id)    AS page_count
    FROM layouts l
    LEFT JOIN templates t ON t.layout_id = l.id AND t.deleted_at IS NULL
    LEFT JOIN pages p     ON p.template_id = t.id AND p.deleted_at IS NULL
    WHERE l.id = ${layoutId}::uuid
      AND l.deleted_at IS NULL
    GROUP BY l.id, l.slug, l.display_name
  `)) as unknown as Array<{
    layout_id: string;
    slug: string;
    display_name: string;
    template_count: string | number;
    page_count: string | number;
  }>;
  const row = rows[0];
  if (!row) {
    return {
      error: err({
        kind: "HandlerError",
        operation: "layouts.propose_*",
        message: "layout not found or deleted",
      }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } },
    };
  }
  return {
    value: {
      layoutId: row.layout_id,
      slug: row.slug,
      displayName: row.display_name,
      boundTemplateCount: Number(row.template_count),
      affectedPageCount: Number(row.page_count),
    },
  };
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
    operation: "layouts.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}
