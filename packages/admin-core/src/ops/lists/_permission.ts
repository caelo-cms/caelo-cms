// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — who may change the STRUCTURE (list types, page types).
 *
 * Writing a list type or a page type needs `content.structure`, granted by
 * default to every role that holds `content.write` (migration 0350,
 * docs/lists.md §11). The ops are routine (no §11.A gate) and open to the
 * AI, so the check runs inside the op: a human needs the permission
 * through a role; the AI acts for the operator whose chat it runs in and
 * needs it there; the system actor (and a chat the platform itself
 * opened) always may.
 *
 * The role tables are readable by every session (open RLS); `users` and
 * `actors` are not readable by an AI session, so the check never joins
 * them — a deleted operator has no role rows left to grant anything.
 */

import { SYSTEM_ACTOR_ID, type TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

const PERMISSION = "content.structure";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Null when `ctx` may write list types / page types, else an AI-actionable
 * refusal message for `operation`.
 */
export async function structureWriteRefusal(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  operation: string,
): Promise<string | null> {
  if (ctx.actorKind === "system") return null;
  let operatorId: string | null = null;
  if (ctx.actorKind === "human") {
    operatorId = ctx.actorId;
  } else if (ctx.actorKind === "ai" && ctx.chatTaskId && UUID_RE.test(ctx.chatTaskId)) {
    // The chat's operator (a subagent's task maps to its parent chat).
    const rows = (await tx.execute(sql`
      SELECT cs.created_by::text AS created_by FROM chat_sessions cs
      WHERE cs.id = caelo_chat_owner(${ctx.chatTaskId}::uuid)
    `)) as unknown as { created_by: string }[];
    operatorId = rows[0]?.created_by ?? null;
  }
  if (operatorId === SYSTEM_ACTOR_ID) return null;
  if (operatorId === null) {
    return `permission_denied: ${operation} changes the structure of lists or pages and runs only in a chat or for a person holding ${PERMISSION}. Nothing was changed.`;
  }
  const held = (await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ${operatorId}::uuid AND p.name = ${PERMISSION}
    ) AS allowed
  `)) as unknown as { allowed: boolean }[];
  if (held[0]?.allowed === true) return null;
  return (
    `permission_denied: ${operation} needs the ${PERMISSION} permission (defining list types and page types), ` +
    "which this operator's role does not have. Nothing was changed. Edit the list's entries instead " +
    "(lists.upsert_many / lists.patch_items_many), or ask an Owner to grant " +
    `${PERMISSION} to the role.`
  );
}
