// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.37 — `pending_proposals.cancel`. Lets the AI withdraw a
 * proposal it queued in error WITHOUT making the Owner click Reject.
 *
 * Scope:
 *  - actorScope: ["human", "ai", "system"] but the handler restricts
 *    AI callers to rows where proposed_by = ctx.actorId. Human callers
 *    can cancel any of their own proposals. (Reject-on-behalf-of-others
 *    is the operator's existing /security/<domain>/pending Reject button.)
 *  - Sets status='cancelled' (added to the CHECK in v0.2.35) on the
 *    matching row in whichever *_pending_actions table holds the id.
 *  - Idempotent: cancelling an already-applied/rejected/cancelled row
 *    returns OK with `wasAlreadyDecided: true`.
 *
 * Implementation: tries each table in turn via UPDATE ... WHERE id=$1
 * AND status='pending' AND proposed_by=<ctx>. Postgres returns 0 rows
 * affected for a miss; the loop continues. Cheap because only one
 * table can match (uuid uniqueness).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

const PENDING_TABLES = [
  "deploy_pending_actions",
  "layout_pending_actions",
  "user_pending_actions",
  "role_pending_actions",
  "snapshot_revert_pending_actions",
  "experiment_pending_actions",
  "email_config_pending_actions",
  "ai_providers_pending_actions",
  "mcp_token_pending_actions",
  "template_pending_actions",
  "domain_pending_actions",
] as const;

export const cancelProposalOp = defineOperation({
  name: "pending_proposals.cancel",
  // AI can cancel its own proposals; humans can cancel theirs.
  // The WHERE clause's proposed_by check enforces this — no ambient
  // permission grant lets one actor cancel another's queued row.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({
    cancelled: z.boolean(),
    domain: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    // Iterate the tables via a discriminated switch. UPDATE WHERE
    // id=$1 AND status='pending' AND proposed_by=<actor> → 0 rows for
    // a miss; 1 row when we find the owning table. Postgres uses each
    // table's PK index → cheap. Switch statement keeps the table name
    // out of the parameterized query; reason + actorId stay parameterized.
    const reason = input.reason ?? "ai-cancelled";
    for (const table of PENDING_TABLES) {
      const updated = await runCancelOnTable(tx, table, input.proposalId, ctx.actorId, reason);
      if (updated.length > 0) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "pending_proposals.cancel",
          input,
          succeeded: true,
          entityId: input.proposalId,
          resultSummary: `cancelled in ${table}`,
        });
        return ok({ cancelled: true, domain: tableToDomain(table) });
      }
    }
    // No table held a pending row for this id+actor — could be already
    // decided, wrong actor, or a non-existent id. Surface a structured
    // result so the AI can tell the user.
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pending_proposals.cancel",
      input,
      succeeded: false,
      resultSummary: "no-matching-pending-row",
    });
    return err({
      kind: "HandlerError",
      operation: "pending_proposals.cancel",
      message:
        "No pending proposal found for that id (already decided, or proposed by a different actor).",
    });
  },
});

/**
 * Per-table UPDATE with parameterized values. Switch on the literal
 * table name keeps the table identifier out of the parameter list
 * (Postgres can't bind table names) without using sql.raw on
 * untrusted input.
 */
async function runCancelOnTable(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  table: (typeof PENDING_TABLES)[number],
  proposalId: string,
  actorId: string,
  reason: string,
): Promise<{ id: string }[]> {
  switch (table) {
    case "deploy_pending_actions":
      return (await tx.execute(sql`
        UPDATE deploy_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "layout_pending_actions":
      return (await tx.execute(sql`
        UPDATE layout_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "user_pending_actions":
      return (await tx.execute(sql`
        UPDATE user_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "role_pending_actions":
      return (await tx.execute(sql`
        UPDATE role_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "snapshot_revert_pending_actions":
      return (await tx.execute(sql`
        UPDATE snapshot_revert_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "experiment_pending_actions":
      return (await tx.execute(sql`
        UPDATE experiment_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "email_config_pending_actions":
      return (await tx.execute(sql`
        UPDATE email_config_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "ai_providers_pending_actions":
      return (await tx.execute(sql`
        UPDATE ai_providers_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "mcp_token_pending_actions":
      return (await tx.execute(sql`
        UPDATE mcp_token_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "template_pending_actions":
      return (await tx.execute(sql`
        UPDATE template_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    case "domain_pending_actions":
      return (await tx.execute(sql`
        UPDATE domain_pending_actions SET status='cancelled', decided_at=now(),
          decided_by=${actorId}::uuid, decision_reason=${reason}
        WHERE id=${proposalId}::uuid AND status='pending' AND proposed_by=${actorId}::uuid
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
  }
}

function tableToDomain(table: string): string {
  // Strip _pending_actions suffix; map snapshot_revert → snapshots.
  if (table === "snapshot_revert_pending_actions") return "snapshots";
  if (table === "ai_providers_pending_actions") return "ai_providers";
  if (table === "mcp_token_pending_actions") return "mcp_tokens";
  if (table === "email_config_pending_actions") return "email_config";
  return table.replace(/_pending_actions$/, "") + "s".replace(/ss$/, "s");
}
