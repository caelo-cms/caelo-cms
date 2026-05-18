// SPDX-License-Identifier: MPL-2.0

/**
 * v0.9.0 — Branched-create read overlay + cross-chat write-block helpers.
 *
 * The chat-branched-writes pattern (v0.5.x) tags writes with
 * `ctx.chatBranchId` so two chats can edit different entities without
 * stepping on each other. v0.5.7 tried to extend this to CREATES too
 * (pages.create with branch isolation) but the read paths weren't
 * updated — every "create then read" AI workflow broke and v0.5.19
 * reverted the change. v0.9.0 finishes the retrofit: every primary
 * content table (modules / templates / layouts / pages) gets a
 * `chat_branch_id` column, reads in chat context use the overlay
 * filter below, writes that reference other branches get rejected.
 *
 * Three helpers cover every site:
 *
 *   - `branchVisibilityFilter(ctx)` — for branch-aware reads. Returns
 *     rows that are either main (chat_branch_id IS NULL) or branched
 *     to the caller's chat. System actors with no chatBranchId see
 *     main-only.
 *
 *   - `mainOnlyFilter` — for paths that must skip branches regardless
 *     of caller (static-generator, admin /security pages by default,
 *     slug-uniqueness checks).
 *
 *   - `requireUsableEntity(tx, ctx, kind, entityId)` — defense-in-depth
 *     write-block. Called before any write that REFERENCES an entity
 *     by id (pages.set_modules takes moduleIds; pages.create takes
 *     templateId; etc.). Rejects with a structured Locked-style error
 *     when the referenced row is branched to a different chat.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";

/**
 * SQL fragment for the WHERE clause of branch-aware reads.
 *
 * Returns main rows (`chat_branch_id IS NULL`) plus rows branched to
 * the caller's chat (`chat_branch_id = ctx.chatBranchId`). System
 * actors with no chatBranchId get main-only.
 *
 * Compose with other filters:
 *   ```ts
 *   SELECT ... FROM modules
 *   WHERE deleted_at IS NULL ${branchVisibilityFilter(ctx)}
 *   ```
 *
 * Always prefixed with ` AND ` so it slots into existing WHERE chains
 * — callers should NOT add their own AND in front.
 */
export function branchVisibilityFilter(ctx: ExecutionContext): SQL {
  if (!ctx.chatBranchId) {
    return sql` AND chat_branch_id IS NULL`;
  }
  return sql` AND (chat_branch_id IS NULL OR chat_branch_id = ${ctx.chatBranchId}::uuid)`;
}

/**
 * Main-only filter — strips every branched row regardless of caller.
 * Used by paths that MUST NOT see branched content under any
 * circumstances:
 *
 *   - static-generator (apps/static-generator/src/generate.ts) —
 *     production deploys must never ship an unpromoted entity.
 *   - slug-uniqueness validation on `*.create` — branches have their
 *     own slug namespace (via the partial UNIQUE INDEX in migration
 *     0089), so create-time uniqueness checks only collide on main.
 *   - /security/* admin pages (v0.9.0 first cut — a future toggle
 *     adds a "show all branches" mode for operator audit).
 */
export const mainOnlyFilter: SQL = sql` AND chat_branch_id IS NULL`;

/**
 * Validate that a referenced entity is usable by the caller's branch
 * before a write that depends on it. Returns `{ ok: true }` when the
 * entity is on main, branched to the caller's chat, or the caller is
 * a system actor (no branch context). Returns a structured error
 * when the entity is branched to a *different* chat — that's the
 * cross-chat reference attack/mistake we want to block.
 *
 * Why this exists when reads already hide cross-branch entities: an
 * AI could plausibly have a stale UUID it cached from a previous turn
 * before chat-1 picked it up, or an operator could paste a UUID from
 * /security/modules' debug view. The validation is defense in depth.
 *
 * Returned error shape matches the existing `Locked` family so the
 * chat-runner's existing error-translation path (chat-runner.ts:1242)
 * surfaces it sensibly without new code.
 */
/**
 * Matches the canonical Locked shape in `@caelo-cms/query-api`'s
 * `QueryError` union — `entityKind` is widened to `string` and the
 * `holder` field is required. For cross-chat-reference rejections
 * the holder's chatSessionId is the holding branch (we resolve it
 * via the entity's chat_branch_id column); a future v0.9.x improvement
 * could enrich with the holding chat's title + anchor page.
 */
export type BranchUsabilityError = {
  kind: "Locked";
  operation: string;
  message: string;
  entityKind: string;
  entityId: string;
  holder: {
    chatSessionId: string;
    chatBranchId: string;
    lockedAt: string;
  };
};

type RefEntityKind = "module" | "template" | "layout" | "page";

const TABLE_BY_KIND: Record<RefEntityKind, string> = {
  module: "modules",
  template: "templates",
  layout: "layouts",
  page: "pages",
};

export async function requireUsableEntity(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  kind: RefEntityKind,
  entityId: string,
  operation: string,
): Promise<{ ok: true } | { ok: false; error: BranchUsabilityError }> {
  const table = TABLE_BY_KIND[kind];
  // Inline the table name — bound parameters can't substitute identifiers
  // and the value comes from a closed enum, not user input.
  const rows = (await tx.execute(sql`
    SELECT chat_branch_id::text AS chat_branch_id
    FROM ${sql.raw(table)}
    WHERE id = ${entityId}::uuid AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as { chat_branch_id: string | null }[];
  const row = rows[0];
  const stubHolder = {
    chatSessionId: row?.chat_branch_id ?? "00000000-0000-0000-0000-000000000000",
    chatBranchId: row?.chat_branch_id ?? "00000000-0000-0000-0000-000000000000",
    lockedAt: new Date().toISOString(),
  };
  if (!row) {
    return {
      ok: false,
      error: {
        kind: "Locked",
        operation,
        message: `${kind} ${entityId} not found`,
        entityKind: kind,
        entityId,
        holder: stubHolder,
      },
    };
  }
  // Main entity: always usable.
  if (row.chat_branch_id === null) return { ok: true };
  // System actor with no branch context bypasses (e.g., static-gen
  // synthetic writes); production reads themselves use mainOnlyFilter
  // so this is a narrow escape hatch for system tooling.
  if (!ctx.chatBranchId) return { ok: true };
  // Same-chat reference: usable.
  if (row.chat_branch_id === ctx.chatBranchId) return { ok: true };
  // Cross-chat: reject.
  return {
    ok: false,
    error: {
      kind: "Locked",
      operation,
      message: `${kind} ${entityId} is pending in another chat — wait for that chat to stage, or pick a ${kind} from main`,
      entityKind: kind,
      entityId,
      holder: stubHolder,
    },
  };
}
