// SPDX-License-Identifier: MPL-2.0

/**
 * #1156 — the one write path of a page's SEO fields (every `pages_seo.*`
 * write op goes through it).
 *
 * In a chat (`ctx.chatBranchId` set) the write takes the page lock like
 * any page edit, builds on the page's state in the chat's view and emits a
 * page snapshot on the branch carrying the new `seo` — the live row is not
 * touched until a Stage merges it. Outside a chat (the SEO panel, a system
 * job) the live row is written and a main snapshot records it, so a revert
 * can restore it (CLAUDE.md §2: every write emits a snapshot).
 */

import { OperationAbortError, type QueryError, type TransactionRunner } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok, type Result } from "@caelo-cms/shared";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../locks.js";
import {
  emitSnapshot,
  loadPageState,
  loadPageStateWithBranchOverlay,
  type SnapshotEntity,
  type SnapshotOpKind,
} from "../snapshots/index.js";
import type { PageSeoState, PageState } from "../snapshots/state.js";
import { applyPageSeoState, loadLivePageSeo, PAGE_SEO_COLUMN_DEFAULTS } from "./page-seo.js";

/** A page opened for an SEO write: its state in the caller's view and its current SEO. */
export interface OpenedPageSeo {
  readonly pageId: string;
  readonly page: PageState;
  readonly current: PageSeoState;
}

/**
 * Read what an SEO write would build on, WITHOUT taking the lock: the
 * page's state in the caller's view and its current SEO there. Ops decide
 * their refusals on this first — taking the lock can take over another
 * chat's pending change, which must not happen for a write that is then
 * refused (it would commit with the refusal). Refuses a page the caller
 * cannot see or that is deleted in its view.
 */
export async function peekPageSeo(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  operation: string,
  pageId: string,
): Promise<Result<OpenedPageSeo, QueryError>> {
  const page = ctx.chatBranchId
    ? await loadPageStateWithBranchOverlay(tx, pageId, ctx.chatBranchId)
    : await loadPageState(tx, pageId);
  if (!page || page.deletedAt !== null) {
    return err({
      kind: "HandlerError",
      operation,
      message: `no page with id ${pageId} (or it is deleted) — take page ids from list_pages and call again.`,
    });
  }
  // A pending page snapshot that did not write SEO carries none: the live
  // row is still this page's SEO in the caller's view (seo/page-seo.ts).
  const current =
    page.seo ?? (await loadLivePageSeo(tx, [pageId])).get(pageId) ?? PAGE_SEO_COLUMN_DEFAULTS;
  return ok({ pageId, page, current });
}

/**
 * Lock the page (in a chat) and read what an SEO write builds on, as
 * {@link peekPageSeo} — which runs first, so an unknown page is refused
 * before the lock.
 *
 * @param refuse the op's own refusal rule on the current SEO. Checked on
 *   the peek (a refusal there returns before the lock) and again under the
 *   lock: if a takeover changed the state into a refused one, the write
 *   THROWS `OperationAbortError`, rolling the takeover back with it.
 */
export async function openPageSeoWrite(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  operation: string,
  pageId: string,
  refuse?: (opened: OpenedPageSeo) => QueryError | null,
): Promise<Result<OpenedPageSeo, QueryError>> {
  const before = await peekPageSeo(ctx, tx, operation, pageId);
  if (!before.ok) return before;
  const early = refuse?.(before.value);
  if (early) return err(early);
  if (!ctx.chatBranchId) return before;
  const lock = await checkAndAcquireEntityLock(tx, {
    kind: "page",
    entityId: pageId,
    chatBranchId: ctx.chatBranchId,
    holderKey: ctx.chatTaskId,
  });
  if (!lock.permitted) {
    return err(await entityWriteBlockedError(tx, operation, "page", pageId, lock));
  }
  // Read again under the lock (a takeover may have moved a change here).
  const opened = await peekPageSeo(ctx, tx, operation, pageId);
  const late = opened.ok ? refuse?.(opened.value) : opened.error;
  if (late) throw new OperationAbortError(late);
  return opened;
}

/** True when `next` changes nothing of `current` (no write, no snapshot). */
export function sameSeo(current: PageSeoState, next: PageSeoState): boolean {
  return (Object.keys(current) as (keyof PageSeoState)[]).every((k) => current[k] === next[k]);
}

/**
 * Commit SEO writes opened with {@link openPageSeoWrite}: one snapshot
 * header for all of them, on the caller's branch in a chat (the live row
 * untouched), else on main after writing the live rows.
 */
export async function commitPageSeoWrites(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  writes: readonly { readonly opened: OpenedPageSeo; readonly next: PageSeoState }[],
  opKind: SnapshotOpKind,
  description: string,
): Promise<void> {
  if (writes.length === 0) return;
  const entities: SnapshotEntity[] = [];
  for (const { opened, next } of writes) {
    if (ctx.chatBranchId) {
      entities.push({
        kind: "page",
        entityId: opened.pageId,
        state: { ...opened.page, seo: next },
      });
      continue;
    }
    await applyPageSeoState(tx, opened.pageId, next, ctx.actorId);
    const state = await loadPageState(tx, opened.pageId);
    if (state)
      entities.push({ kind: "page", entityId: opened.pageId, state: { ...state, seo: next } });
  }
  await emitSnapshot(tx, {
    actorId: ctx.actorId,
    opKind,
    description: `${description}${ctx.chatBranchId ? " (branched)" : ""}`,
    chatTaskId: ctx.chatTaskId ?? null,
    chatBranchId: ctx.chatBranchId ?? null,
    entities,
  });
}
