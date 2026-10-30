// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs — `pages.move_many` (reparent + optional rename, the
 * whole subtree moving with each page) and its dry run
 * `pages.plan_moves`.
 *
 * One op, one transaction, for what would otherwise be a chain of calls
 * (CLAUDE.md §11): validate the tree change in the caller's branch view
 * ({@link planPageMoves}), write it, recompute every affected path, and
 * give each moved URL its 301 ({@link applyPathMoveEffects}). Links on
 * the site are page references (epic #724) and follow the move without
 * being touched. A refused plan changes nothing.
 *
 * Branch semantics match a slug change: inside a chat the move is a
 * pending page snapshot per moved page (the chat's preview and
 * pages.list see the new tree at once); the live URLs and redirects
 * happen when the chat is published.
 */

import { defineOperation, type QueryError, type TransactionRunner } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  pagesMoveManySchema,
  type Result,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitDomainEvent } from "../../domain-events.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadPageState,
  loadPageStateWithBranchOverlay,
  type SnapshotEntity,
} from "../../snapshots/index.js";
import { recomputeCurrentPathsWithMoves, renderScopeOf } from "./current-path.js";
import { planPageMoves, type TreeChange } from "./page-move-plan.js";
import { applyPathMoveEffects, type PathMoveEffects } from "./path-moves.js";

const OP = "pages.move_many";

/** One URL that moves (moved pages and their descendants). */
const movedUrlSchema = z.object({ pageId: z.string(), from: z.string(), to: z.string() });

const moveResultSchema = z.object({
  /** Every URL the move changes — the moved pages and all descendants. */
  moved: z.array(movedUrlSchema),
  /** True inside a chat: the URLs change when the chat is published. */
  pendingPublish: z.boolean(),
  redirectsCreated: z.number().int(),
});
export type PageMoveResult = z.infer<typeof moveResultSchema>;

const NO_EFFECTS: PathMoveEffects = { redirectsCreated: 0 };

/**
 * Move pages — the shared engine behind `pages.move_many` and
 * `pages.delete`'s `children: "move-up"`. Runs on the caller's tx.
 */
export async function executePageMoves(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  changes: readonly TreeChange[],
  redirects: "auto" | "skip",
): Promise<Result<PageMoveResult, QueryError>> {
  for (const c of changes) {
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: c.pageId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) return err(await entityWriteBlockedError(tx, OP, "page", c.pageId, lock));
  }

  const scope = renderScopeOf(ctx, tx);
  const planned = await planPageMoves(tx, scope, changes);
  if (!planned.ok) {
    return err({ kind: "HandlerError", operation: OP, message: planned.message });
  }

  const branched = !!ctx.chatBranchId;
  const entities: SnapshotEntity[] = [];
  let moved = planned.plan.moves;
  let effects = NO_EFFECTS;
  if (branched) {
    for (const c of changes) {
      const base = await loadPageStateWithBranchOverlay(tx, c.pageId, ctx.chatBranchId);
      if (!base) {
        return err({ kind: "HandlerError", operation: OP, message: `page ${c.pageId} not found` });
      }
      const { pendingRedirects: _prev, ...rest } = base;
      entities.push({
        kind: "page",
        entityId: c.pageId,
        state: {
          ...rest,
          ...(redirects === "skip" ? { pendingRedirects: "skip" as const } : {}),
          slug: c.newSlug ?? base.slug,
          parentPageId: c.parentPageId === undefined ? (base.parentPageId ?? null) : c.parentPageId,
          version: base.version + 1,
          deletedAt: null,
        },
      });
    }
  } else {
    for (const c of changes) {
      await tx.execute(sql`
        UPDATE pages SET
          ${c.parentPageId === undefined ? sql`` : sql`parent_page_id = ${c.parentPageId}::uuid,`}
          slug = ${c.newSlug === undefined ? sql`slug` : c.newSlug},
          version = version + 1,
          updated_at = now()
        WHERE id = ${c.pageId}::uuid
      `);
    }
    const recomputed = await recomputeCurrentPathsWithMoves(
      tx,
      changes.map((c) => c.pageId),
      scope,
    );
    moved = recomputed.moves;
    effects = await applyPathMoveEffects(ctx, tx, moved, redirects);
    for (const c of changes) {
      const state = await loadPageState(tx, c.pageId);
      if (state) entities.push({ kind: "page", entityId: c.pageId, state });
    }
  }

  await emitSnapshot(tx, {
    actorId: ctx.actorId,
    opKind: OP,
    description: `${OP} pages=${changes.length} urls=${moved.length}${branched ? " (branched)" : ""}`,
    chatTaskId: ctx.chatTaskId ?? null,
    chatBranchId: ctx.chatBranchId ?? null,
    entities,
  });
  for (const e of entities) {
    await emitDomainEvent(tx, {
      kind: "page.updated",
      entityId: e.entityId,
      payload: {
        moved: true,
        ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
      },
    });
  }
  return ok({
    moved: moved.map((m) => ({ pageId: m.pageId, from: m.from, to: m.to })),
    pendingPublish: branched,
    redirectsCreated: effects.redirectsCreated,
  });
}

export const movePagesManyOp = defineOperation({
  name: OP,
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: pagesMoveManySchema,
  output: moveResultSchema,
  handler: async (ctx, input, tx) => {
    const r = await executePageMoves(
      ctx,
      tx,
      input.moves.map((m) => ({
        pageId: m.pageId,
        parentPageId: m.parentPageId,
        ...(m.newSlug !== undefined ? { newSlug: m.newSlug } : {}),
      })),
      input.redirectFromOld,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: OP,
      input,
      succeeded: r.ok,
      resultSummary: r.ok
        ? `urls=${r.value.moved.length}`
        : ("message" in r.error ? r.error.message : r.error.kind).slice(0, 200),
    });
    return r;
  },
});

/**
 * Dry run of `pages.move_many`: the URLs a move (or a rename, via
 * `newSlug`) would change, or why it would be refused. Read-only — the
 * AI previews a restructure with it, and the move tool's approval gate
 * sizes the blast radius with it.
 */
export const planPageMovesOp = defineOperation({
  name: "pages.plan_moves",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      moves: z
        .array(
          z
            .object({
              pageId: z.string().uuid(),
              /** Omit to keep the parent (a pure rename). */
              parentPageId: z.string().uuid().nullable().optional(),
              newSlug: z.string().min(1).max(64).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  output: z.object({
    ok: z.boolean(),
    /** Why the move would be refused (ok=false). */
    refusal: z.string().nullable(),
    moved: z.array(movedUrlSchema),
  }),
  handler: async (ctx, input, tx) => {
    const planned = await planPageMoves(
      tx,
      renderScopeOf(ctx, tx),
      input.moves.map((m) => ({
        pageId: m.pageId,
        ...(m.parentPageId !== undefined ? { parentPageId: m.parentPageId } : {}),
        ...(m.newSlug !== undefined ? { newSlug: m.newSlug } : {}),
      })),
    );
    if (!planned.ok) return ok({ ok: false, refusal: planned.message, moved: [] });
    return ok({
      ok: true,
      refusal: null,
      moved: planned.plan.moves.map((m) => ({ pageId: m.pageId, from: m.from, to: m.to })),
    });
  },
});
