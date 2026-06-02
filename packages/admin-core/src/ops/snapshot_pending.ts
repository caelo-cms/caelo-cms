// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.23 — snapshots.{propose_revert_site, propose_revert_page,
 * propose_revert_template, propose_revert_module, execute_proposal,
 * reject_proposal, list_pending}.
 *
 * Same shape as role_pending (v0.2.22) and user_pending (v0.2.21).
 *
 * Highest blast-radius surface in the propose/execute sweep — site
 * reverts can rewind hundreds of pages with one click. Preview
 * surfaces (a) the snapshot's created_at + chat_id (so the Owner can
 * trace which AI session produced it), and (b) the count of entities
 * affected (module / page / template snapshot rows in the target).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { revertModuleOp } from "./snapshots/revert_module.js";
import { revertPageOp } from "./snapshots/revert_page.js";
import { revertSiteOp } from "./snapshots/revert_site.js";
import { revertTemplateOp } from "./snapshots/revert_template.js";

// ─── propose_revert_site ─────────────────────────────────────────────

const proposeRevertSiteInput = z.object({ snapshotId: z.string().uuid() }).strict();

export const proposeRevertSiteOp = defineOperation({
  name: "snapshots.propose_revert_site",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRevertSiteInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const snap = await loadSnapshot(tx, input.snapshotId);
    if (!snap) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.propose_revert_site",
        message: `snapshot ${input.snapshotId} not found`,
      });
    }
    const counts = await countSnapshotEntities(tx, input.snapshotId);
    const preview = {
      kind: "site",
      snapshotId: snap.id,
      snapshotCreatedAt: snap.created_at_iso,
      snapshotChatId: snap.chat_id,
      ...counts,
      affectedEntityCount:
        counts.moduleCount + counts.pageCount + counts.templateCount + counts.pageLayoutCount,
    };
    return queueProposal(
      tx,
      ctx,
      "site",
      input.snapshotId,
      null,
      input,
      preview,
      "snapshots.propose_revert_site",
    );
  },
});

// ─── propose_revert_page ─────────────────────────────────────────────

const proposeRevertPageInput = z
  .object({ pageId: z.string().uuid(), snapshotId: z.string().uuid() })
  .strict();

export const proposeRevertPageOp = defineOperation({
  name: "snapshots.propose_revert_page",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRevertPageInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const snap = await loadSnapshot(tx, input.snapshotId);
    if (!snap) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.propose_revert_page",
        message: `snapshot ${input.snapshotId} not found`,
      });
    }
    const pageMeta = await loadPageMeta(tx, input.pageId);
    const preview = {
      kind: "page",
      snapshotId: snap.id,
      snapshotCreatedAt: snap.created_at_iso,
      snapshotChatId: snap.chat_id,
      pageId: input.pageId,
      pageSlug: pageMeta?.slug ?? null,
      pageTitle: pageMeta?.title ?? null,
    };
    return queueProposal(
      tx,
      ctx,
      "page",
      input.snapshotId,
      input.pageId,
      input,
      preview,
      "snapshots.propose_revert_page",
    );
  },
});

// ─── propose_revert_template ─────────────────────────────────────────

const proposeRevertTemplateInput = z
  .object({ templateId: z.string().uuid(), snapshotId: z.string().uuid() })
  .strict();

export const proposeRevertTemplateOp = defineOperation({
  name: "snapshots.propose_revert_template",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRevertTemplateInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const snap = await loadSnapshot(tx, input.snapshotId);
    if (!snap) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.propose_revert_template",
        message: `snapshot ${input.snapshotId} not found`,
      });
    }
    const tmpl = (await tx.execute(sql`
      SELECT name, slug FROM templates WHERE id = ${input.templateId}::uuid LIMIT 1
    `)) as unknown as { name: string; slug: string }[];
    const boundPages = (await tx.execute(sql`
      SELECT count(*)::int AS c FROM pages WHERE template_id = ${input.templateId}::uuid
    `)) as unknown as { c: number }[];
    const preview = {
      kind: "template",
      snapshotId: snap.id,
      snapshotCreatedAt: snap.created_at_iso,
      snapshotChatId: snap.chat_id,
      templateId: input.templateId,
      templateName: tmpl[0]?.name ?? null,
      templateSlug: tmpl[0]?.slug ?? null,
      // Reverting a template re-renders every page bound to it.
      affectedPageCount: boundPages[0]?.c ?? 0,
    };
    return queueProposal(
      tx,
      ctx,
      "template",
      input.snapshotId,
      input.templateId,
      input,
      preview,
      "snapshots.propose_revert_template",
    );
  },
});

// ─── propose_revert_module ───────────────────────────────────────────

const proposeRevertModuleInput = z
  .object({ moduleId: z.string().uuid(), snapshotId: z.string().uuid() })
  .strict();

export const proposeRevertModuleOp = defineOperation({
  name: "snapshots.propose_revert_module",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRevertModuleInput,
  output: z.object({
    proposalId: z.string(),
    preview: z.record(z.string(), z.unknown()),
  }),
  handler: async (ctx, input, tx) => {
    const snap = await loadSnapshot(tx, input.snapshotId);
    if (!snap) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.propose_revert_module",
        message: `snapshot ${input.snapshotId} not found`,
      });
    }
    const mod = (await tx.execute(sql`
      SELECT slug, kind FROM modules WHERE id = ${input.moduleId}::uuid LIMIT 1
    `)) as unknown as { slug: string; kind: string }[];
    const preview = {
      kind: "module",
      snapshotId: snap.id,
      snapshotCreatedAt: snap.created_at_iso,
      snapshotChatId: snap.chat_id,
      moduleId: input.moduleId,
      moduleSlug: mod[0]?.slug ?? null,
      moduleKind: mod[0]?.kind ?? null,
    };
    return queueProposal(
      tx,
      ctx,
      "module",
      input.snapshotId,
      input.moduleId,
      input,
      preview,
      "snapshots.propose_revert_module",
    );
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

export const executeSnapshotRevertProposalOp = defineOperation({
  name: "snapshots.execute_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ siteSnapshotId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, snapshot_id::text AS snapshot_id,
             entity_id::text AS entity_id, payload, status
      FROM snapshot_revert_pending_actions
      WHERE id = ${input.proposalId}::uuid LIMIT 1
    `)) as unknown as Array<{
      id: string;
      kind: "site" | "page" | "template" | "module";
      snapshot_id: string;
      entity_id: string | null;
      payload: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.execute_proposal",
        message: "proposal not found",
      });
    }
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "snapshots.execute_proposal",
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as Record<string, unknown>;
    let siteSnapshotId: string | null = null;
    if (row.kind === "site") {
      const r = await revertSiteOp.handler(
        ctx,
        payload as Parameters<typeof revertSiteOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "revert_site");
      siteSnapshotId = (r.value as { siteSnapshotId: string }).siteSnapshotId;
    } else if (row.kind === "page") {
      const r = await revertPageOp.handler(
        ctx,
        payload as Parameters<typeof revertPageOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "revert_page");
      siteSnapshotId = (r.value as { siteSnapshotId: string }).siteSnapshotId;
    } else if (row.kind === "template") {
      const r = await revertTemplateOp.handler(
        ctx,
        payload as Parameters<typeof revertTemplateOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "revert_template");
      siteSnapshotId = (r.value as { siteSnapshotId: string }).siteSnapshotId;
    } else if (row.kind === "module") {
      const r = await revertModuleOp.handler(
        ctx,
        payload as Parameters<typeof revertModuleOp.handler>[1],
        tx,
      );
      if (!r.ok) return passthroughError(r.error, "revert_module");
      siteSnapshotId = (r.value as { siteSnapshotId: string }).siteSnapshotId;
    }
    await tx.execute(sql`
      UPDATE snapshot_revert_pending_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          applied_snapshot_id = ${siteSnapshotId === null ? null : sql`${siteSnapshotId}::uuid`}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "snapshots.execute_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind} reverted (newSnapshot=${siteSnapshotId ?? "(none)"})`,
    });
    return ok({ siteSnapshotId });
  },
});

export const rejectSnapshotRevertProposalOp = defineOperation({
  name: "snapshots.reject_proposal",
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
      UPDATE snapshot_revert_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "snapshots.reject_proposal",
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
  kind: z.enum(["site", "page", "template", "module"]),
  proposedBy: z.string(),
  snapshotId: z.string(),
  entityId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listPendingSnapshotRevertProposalsOp = defineOperation({
  name: "snapshots.list_pending",
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
        snapshot_id::text AS snapshot_id, entity_id::text AS entity_id,
        payload, preview, status,
        created_at, decided_at, decided_by::text AS decided_by, decision_reason
      FROM snapshot_revert_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      kind: "site" | "page" | "template" | "module";
      proposed_by: string;
      snapshot_id: string;
      entity_id: string | null;
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
        snapshotId: r.snapshot_id,
        entityId: r.entity_id,
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

async function loadSnapshot(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  snapshotId: string,
): Promise<{ id: string; created_at_iso: string; chat_id: string | null } | null> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, created_at, chat_id::text AS chat_id
    FROM site_snapshots WHERE id = ${snapshotId}::uuid LIMIT 1
  `)) as unknown as Array<{ id: string; created_at: Date | string; chat_id: string | null }>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    created_at_iso:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    chat_id: r.chat_id,
  };
}

async function loadPageMeta(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  pageId: string,
): Promise<{ slug: string; title: string } | null> {
  const rows = (await tx.execute(sql`
    SELECT slug, title FROM pages WHERE id = ${pageId}::uuid LIMIT 1
  `)) as unknown as Array<{ slug: string; title: string }>;
  return rows[0] ?? null;
}

async function countSnapshotEntities(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  snapshotId: string,
): Promise<{
  moduleCount: number;
  pageCount: number;
  templateCount: number;
  pageLayoutCount: number;
}> {
  const rows = (await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM module_snapshots WHERE site_snapshot_id = ${snapshotId}::uuid) AS mc,
      (SELECT count(*)::int FROM page_snapshots WHERE site_snapshot_id = ${snapshotId}::uuid) AS pc,
      (SELECT count(*)::int FROM template_snapshots WHERE site_snapshot_id = ${snapshotId}::uuid) AS tc,
      (SELECT count(*)::int FROM page_layout_snapshots WHERE site_snapshot_id = ${snapshotId}::uuid) AS plc
  `)) as unknown as Array<{ mc: number; pc: number; tc: number; plc: number }>;
  const r = rows[0] ?? { mc: 0, pc: 0, tc: 0, plc: 0 };
  return {
    moduleCount: r.mc,
    pageCount: r.pc,
    templateCount: r.tc,
    pageLayoutCount: r.plc,
  };
}

async function queueProposal(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: { actorId: string; requestId: string; chatBranchId?: string },
  kind: "site" | "page" | "template" | "module",
  snapshotId: string,
  entityId: string | null,
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
      INSERT INTO snapshot_revert_pending_actions
        (kind, proposed_by, snapshot_id, entity_id, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${snapshotId}::uuid,
        ${entityId === null ? null : sql`${entityId}::uuid`},
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
    operation: "snapshots.execute_proposal",
    message: `underlying ${kind} failed: ${msg}`,
  }) as { ok: false; error: { kind: "HandlerError"; operation: string; message: string } };
}
