// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner queue over `plugin_pending_actions` (activate / uninstall /
 * revoke_capability).
 *
 * In the chat a gated plugin tool proposes and applies in one approved
 * step, so rows never wait. Over the Power-MCP an external agent has no
 * in-chat card: the gated tool falls back to propose-only and the row
 * waits for the Owner. Until now nothing listed or decided those rows —
 * an MCP-proposed uninstall or activation could never be approved. These
 * two ops back `/security/plugins/pending`; approve there dispatches to
 * the row's executor (`plugins.execute_activation` / `plugins.execute_proposal`).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok, proposalStatus } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { parsePayload } from "../_propose-helpers.js";

const pendingRow = z.object({
  id: z.string(),
  kind: z.enum(["activate", "uninstall", "revoke_capability"]),
  proposedBy: z.string(),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
});

export const listPluginPendingActionsOp = defineOperation({
  name: "plugins.list_pending_actions",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({ proposals: z.array(pendingRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by, preview, status, created_at
      FROM plugin_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as Array<{
      id: string;
      kind: "activate" | "uninstall" | "revoke_capability";
      proposed_by: string;
      preview: unknown;
      status: z.infer<typeof proposalStatus>;
      created_at: string | Date;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        preview: parsePayload<Record<string, unknown>>(r.preview),
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

export const rejectPluginProposalOp = defineOperation({
  name: "plugins.reject_proposal",
  // Why human-only (+system): §11.A — the operator's Reject.
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
      UPDATE plugin_pending_actions
         SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
             decision_reason = ${input.reason ?? null}
       WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});
