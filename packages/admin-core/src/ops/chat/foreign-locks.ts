// SPDX-License-Identifier: MPL-2.0

/**
 * issue #262 — `chat.list_foreign_locks`: read-only view of every
 * per-entity write lock held by a chat session OTHER than the caller's.
 *
 * Why this exists: run #7's migration chat only discovered that a stale
 * "Live edit" chat held the theme, the layout-bound chrome modules, and
 * the homepage when its writes started bouncing with `Locked` errors
 * MID-RUN. The chat-runner feeds this op's output into a system-prompt
 * context block so the AI can warn the operator in the plan-check step
 * ("another chat holds the theme — Stage/Publish or discard it first")
 * before any work starts. This is the interim guard until task leases
 * replace chat-session locks (epic #264) — it adds NO lease/TTL
 * mechanics, it only makes the existing lock state visible up front.
 *
 * Each row carries decision-support context per CLAUDE.md §1A: a human
 * label for the entity, the holding chat's title + anchor page, and the
 * holder's pending-change count (snapshots since its last Stage) so the
 * AI can phrase "that chat has N unshipped edits" without a round-trip.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const foreignLockSchema = z
  .object({
    /** Lock table's entity kind (module | template | page | layout | structuredSet | theme | contentInstance | ...). */
    entityKind: z.string(),
    entityId: z.string().uuid(),
    /** Human label for the locked entity (slug/title/display name); falls back to the id. */
    label: z.string(),
    lockedAt: z.string(),
    holder: z.object({
      chatSessionId: z.string().uuid(),
      title: z.string(),
      /** Anchor page slug when the holding chat is page-bound. */
      pageSlug: z.string().nullable(),
      /**
       * Count of the holder branch's site_snapshots since its last Stage —
       * an upper bound of "unshipped edits in that chat". 0 means the chat
       * already Staged everything and merely still holds stale locks.
       */
      pendingChangeCount: z.number().int().nonnegative(),
    }),
  })
  .strict();

export type ForeignLock = z.infer<typeof foreignLockSchema>;

interface ForeignLockRow {
  entity_kind: string;
  entity_id: string;
  locked_at: string | Date;
  holder_session_id: string;
  holder_title: string | null;
  holder_page_slug: string | null;
  pending_change_count: number;
  label: string | null;
}

export const listForeignLocksOp = defineOperation({
  name: "chat.list_foreign_locks",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The caller's own chat session — its locks are excluded. */
      chatSessionId: z.string().uuid(),
    })
    .strict(),
  output: z.object({ locks: z.array(foreignLockSchema) }),
  handler: async (_ctx, input, tx) => {
    // Verify the caller's session exists so a typo'd id fails loudly
    // instead of silently returning EVERY lock as "foreign".
    const sessionRows = (await tx.execute(sql`
      SELECT id::text AS id FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid LIMIT 1
    `)) as unknown as { id: string }[];
    if (!sessionRows[0]) {
      return err({
        kind: "HandlerError",
        operation: "chat.list_foreign_locks",
        message: "session not found",
      });
    }

    // One pass over the lock table. Per-kind LEFT JOINs resolve a human
    // label; the scalar subquery counts the holder branch's snapshots
    // since its last Stage (same "pending" definition as
    // chat.branch_change_count's since-filter, coarser granularity —
    // good enough for a warning, cheap enough for every chat turn).
    const rows = (await tx.execute(sql`
      SELECT
        l.entity_kind,
        l.entity_id::text AS entity_id,
        l.locked_at,
        cs.id::text AS holder_session_id,
        cs.title AS holder_title,
        anchor.slug AS holder_page_slug,
        (
          SELECT COUNT(*)::int FROM site_snapshots ss
          WHERE ss.chat_branch_id = cs.chat_branch_id
            AND ss.created_at > COALESCE(cs.last_staged_at, '-infinity'::timestamptz)
        ) AS pending_change_count,
        COALESCE(
          m.display_name, t.display_name,
          COALESCE(pg.title, pg.slug),
          la.display_name, sset.display_name, th.display_name,
          -- content_instances often have neither display_name nor slug
          -- (per-placement rows); the owning module's slug is the next
          -- most recognisable handle.
          COALESCE(ci.display_name, ci.slug, ci_module.slug),
          r.from_path
        ) AS label
      FROM chat_entity_locks l
      JOIN chat_sessions cs ON cs.id = l.chat_session_id
      LEFT JOIN pages anchor ON anchor.id = cs.page_id AND anchor.deleted_at IS NULL
      LEFT JOIN modules m ON l.entity_kind = 'module' AND m.id = l.entity_id
      LEFT JOIN templates t ON l.entity_kind = 'template' AND t.id = l.entity_id
      LEFT JOIN pages pg ON l.entity_kind IN ('page', 'pageLayout') AND pg.id = l.entity_id
      LEFT JOIN layouts la ON l.entity_kind = 'layout' AND la.id = l.entity_id
      LEFT JOIN structured_sets sset ON l.entity_kind = 'structuredSet' AND sset.id = l.entity_id
      LEFT JOIN themes th ON l.entity_kind = 'theme' AND th.id = l.entity_id
      LEFT JOIN content_instances ci ON l.entity_kind = 'contentInstance' AND ci.id = l.entity_id
      LEFT JOIN modules ci_module ON ci_module.id = ci.module_id
      LEFT JOIN redirects r ON l.entity_kind = 'redirect' AND r.id = l.entity_id
      WHERE l.chat_session_id <> ${input.chatSessionId}::uuid
      ORDER BY l.locked_at DESC
      LIMIT 50
    `)) as unknown as ForeignLockRow[];

    const locks: ForeignLock[] = rows.map((r) => ({
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      label: r.label ?? r.entity_id,
      lockedAt: r.locked_at instanceof Date ? r.locked_at.toISOString() : String(r.locked_at),
      holder: {
        chatSessionId: r.holder_session_id,
        title: r.holder_title ?? "(untitled chat)",
        pageSlug: r.holder_page_slug,
        pendingChangeCount: r.pending_change_count,
      },
    }));

    return ok({ locks });
  },
});
