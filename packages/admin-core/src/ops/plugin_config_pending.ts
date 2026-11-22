// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R6, issue #1645) — plugin_config.{propose_update,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * The §11.A gate of plugin configuration (CLAUDE.md): a plugin marks a
 * field `gate: "approval"` when a wrong value is not undone by one more
 * edit (a cost limit is spent before anyone notices). The AI proposes, a
 * human holding settings.write approves in the chat, and the approved value
 * is written on main, where the next Stage freezes it like every other
 * configuration change.
 *
 * Routine fields never come here: `plugin_config.update` writes them on the
 * chat's branch. A proposal may carry routine fields too, which then apply
 * with the approval, as one change.
 */

import {
  applyApprovedConfig,
  type ConfigChange,
  isPluginDisabled,
  loadedConfigLookup,
  loadedPlugins,
  previewConfigPatch,
} from "@caelo-cms/plugin-host";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok, type ProposalStatus, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { lockPluginRow } from "../locks.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";

const lookup = loadedConfigLookup((slug) => loadedPlugins.bySlug(slug), isPluginDisabled);

/** What a proposal carries. */
export const pluginConfigProposeInput = z
  .object({
    pluginSlug: z.string().regex(/^[a-z][a-z0-9-]{0,54}$/),
    /** A merge patch of the configuration (get_plugin_config shows the fields). */
    patch: z.record(z.string(), z.unknown()),
    /** Why, in the operator's terms: shown on the approval card. */
    reason: z.string().min(1).max(500),
  })
  .strict();

const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

function summaryOf(slug: string, changes: readonly ConfigChange[]): string {
  return `${slug}: ${changes.map((c) => `${c.label} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join(", ")}`;
}

export const proposePluginConfigOp = defineOperation({
  name: "plugin_config.propose_update",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: pluginConfigProposeInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "plugin_config.propose_update";
    const { pluginId, changes } = await previewConfigPatch(
      tx,
      ctx,
      lookup,
      input.pluginSlug,
      input.patch,
    );
    if (changes.length === 0)
      return err({
        kind: "HandlerError",
        operation: op,
        message: "the patch changes nothing: compare it with get_plugin_config",
      });
    if (!changes.some((c) => c.gate === "approval")) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "no field of this patch needs approval: apply it with update_plugin_config instead",
      });
    }
    const preview = {
      summary: summaryOf(input.pluginSlug, changes),
      pluginSlug: input.pluginSlug,
      reason: input.reason,
      changes,
      nextStep:
        "After the approval the values are saved on main; they reach the site with the next Stage and the operator's Publish live.",
    };
    const payloadHash = await hashProposalPayload({
      pluginSlug: input.pluginSlug,
      patch: input.patch,
    });
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
    let rows: { id: string }[];
    try {
      rows = (await tx.execute(sql`
        INSERT INTO plugin_config_pending_actions
          (kind, plugin_id, proposed_by, payload, preview, status, chat_session_id, payload_hash)
        VALUES ('update', ${pluginId}::uuid, ${ctx.actorId}::uuid, ${jsonbParam({ pluginSlug: input.pluginSlug, patch: input.patch })},
                ${jsonbParam(preview)}, 'pending', ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`}, ${payloadHash})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } catch (e) {
      if (isDuplicatePendingError(e))
        return err({ kind: "HandlerError", operation: op, message: DUPLICATE_PROPOSAL_MESSAGE });
      throw e;
    }
    const proposalId = rows[0]?.id;
    if (!proposalId)
      return err({ kind: "HandlerError", operation: op, message: "insert returned no id" });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { pluginSlug: input.pluginSlug, paths: changes.map((c) => c.path) },
      succeeded: true,
      entityId: proposalId,
      resultSummary: preview.summary,
    });
    return ok({ proposalId, preview });
  },
});

const executeDefinition = defineOperation({
  name: "plugin_config.execute_proposal",
  readScope: "request",
  // Why human-only: the operator's Approve click of the §11.A gate; the AI
  // proposes and can never approve its own proposal.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ pluginSlug: z.string(), changed: z.array(z.string()), nextStep: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "plugin_config.execute_proposal";
    const row = await readProposal(tx, input.proposalId);
    if (!row) return err({ kind: "HandlerError", operation: op, message: "proposal not found" });
    if (row.status !== "pending")
      return err({
        kind: "HandlerError",
        operation: op,
        message: `proposal is already ${row.status}`,
      });
    const payload = pluginConfigProposeInput.omit({ reason: true }).parse(row.payload);
    // A field that changed after the proposal would be overwritten blind.
    const now = await previewConfigPatch(tx, ctx, lookup, payload.pluginSlug, payload.patch);
    const proposed = (row.preview.changes ?? []) as ConfigChange[];
    const moved = proposed.filter(
      (p) =>
        JSON.stringify(now.changes.find((c) => c.path === p.path)?.before) !==
        JSON.stringify(p.before),
    );
    if (moved.length > 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `${moved.map((m) => m.label).join(", ")} changed after this proposal was made. Nothing was applied: reject it and propose again from the current values (get_plugin_config).`,
      });
    }
    const result = await applyApprovedConfig(
      tx,
      ctx,
      lookup,
      payload.pluginSlug,
      payload.patch,
      lockPluginRow,
    );
    await tx.execute(sql`
      UPDATE plugin_config_pending_actions
      SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: String(row.preview.summary ?? payload.pluginSlug),
    });
    return ok({
      pluginSlug: payload.pluginSlug,
      changed: result.changed.map((c) => c.path),
      nextStep:
        "Saved on main. It reaches the site with the next Stage (stage_changes) and the operator's Publish live.",
    });
  },
});

/** #589 — the approver must hold settings.write, like the plugin's settings form. */
export const executePluginConfigProposalOp = requiresApproverPermission(
  ["settings.write"],
  executeDefinition,
);

export const rejectPluginConfigProposalOp = defineOperation({
  name: "plugin_config.reject_proposal",
  readScope: "request",
  // Why human-only: the operator's Reject click of the §11.A gate.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({ proposalId: z.string().uuid(), reason: z.string().min(1).max(500).optional() })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE plugin_config_pending_actions
      SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid, decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugin_config.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

export const listPendingPluginConfigProposalsOp = defineOperation({
  name: "plugin_config.list_pending",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        proposedBy: z.string(),
        payload: z.record(z.string(), z.unknown()),
        preview: z.record(z.string(), z.unknown()),
        status: proposalStatus,
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, proposed_by::text AS proposed_by, payload, preview, status, created_at
      FROM plugin_config_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as {
      id: string;
      proposed_by: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
    }[];
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        proposedBy: r.proposed_by,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

async function readProposal(
  tx: TransactionRunner,
  id: string,
): Promise<{ payload: unknown; preview: Record<string, unknown>; status: string } | null> {
  const rows = (await tx.execute(sql`
    SELECT payload, preview, status FROM plugin_config_pending_actions WHERE id = ${id}::uuid
  `)) as unknown as { payload: unknown; preview: Record<string, unknown>; status: string }[];
  return rows[0] ?? null;
}
