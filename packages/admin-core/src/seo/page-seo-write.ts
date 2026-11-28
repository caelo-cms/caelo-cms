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

import {
  OperationAbortError,
  type QueryError,
  type TransactionRunner,
  uuidArray,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  type Result,
  SEO_TEXT_FIELDS,
  type SeoAuthorship,
  type SeoOrigins,
  type SeoTextField,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../locks.js";
import {
  emitSnapshot,
  loadPageState,
  loadPageStateWithBranchOverlay,
  type SnapshotEntity,
  type SnapshotOpKind,
} from "../snapshots/index.js";
import type { PageSeoState, PageState } from "../snapshots/state.js";
import { parsePageSeoState } from "../snapshots/state-schemas.js";
import {
  applyPageSeoState,
  assetKey,
  loadLivePageSeo,
  PAGE_SEO_COLUMN_DEFAULTS,
  pageKey,
  sameSeoValue,
  uuidKey,
} from "./page-seo.js";

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
  rawPageId: string,
): Promise<Result<OpenedPageSeo, QueryError>> {
  const pageId = pageKey(rawPageId);
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
  // The overlay hands over the raw state: its SEO is parsed here, so an
  // older one gets the #1752 head fields before anything builds on it.
  const current =
    page.seo !== undefined
      ? parsePageSeoState(page.seo)
      : ((await loadLivePageSeo(tx, [pageId])).get(pageId) ?? PAGE_SEO_COLUMN_DEFAULTS);
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
  if (ctx.chatBranchId) {
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: pageId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(await entityWriteBlockedError(tx, operation, "page", pageId, lock));
    }
  } else {
    // Outside a chat the write replaces the whole live row from what it
    // read: serialize writers of this page's SEO on the page row, so two
    // concurrent writes (a panel noindex + a system optimize) compose
    // instead of the later one dropping the earlier one's fields.
    await tx.execute(sql`SELECT 1 FROM pages WHERE id = ${pageId}::uuid FOR UPDATE`);
  }
  // Read again under the lock (a takeover, or the write we waited for,
  // may have changed the state).
  const opened = await peekPageSeo(ctx, tx, operation, pageId);
  const late = opened.ok ? refuse?.(opened.value) : opened.error;
  if (late) throw new OperationAbortError(late);
  return opened;
}

/** True when `next` changes nothing of `current` (no write, no snapshot). */
export function sameSeo(current: PageSeoState, next: PageSeoState): boolean {
  return (Object.keys(current) as (keyof PageSeoState)[]).every((k) =>
    sameSeoValue(current[k], next[k]),
  );
}

/** Who a write's new texts are recorded as: a person, or the AI (a plugin and the platform included). */
export function seoAuthorOf(ctx: Pick<ExecutionContext, "actorKind">): SeoAuthorship {
  return ctx.actorKind === "human" ? "human" : "ai";
}

/**
 * #1752 — the authorship of `next`'s own texts after a write by `author`: a
 * text the write changed is the author's, an unchanged one keeps the
 * authorship `next` carries (an op's `reviewed` mark) or had, an empty one
 * has none. Every SEO write goes through it ({@link commitPageSeoWrites}),
 * so no op can store a text without its origin.
 */
export function authorshipAfterWrite(
  current: PageSeoState,
  next: PageSeoState,
  author: SeoAuthorship,
): SeoOrigins {
  const out: Partial<Record<SeoTextField, SeoAuthorship>> = {};
  for (const f of SEO_TEXT_FIELDS) {
    if (next[f].length === 0) continue;
    const kept = next.origins[f] ?? current.origins[f];
    out[f] = next[f] !== current[f] || kept === undefined ? author : kept;
  }
  return out;
}

/**
 * Commit SEO writes opened with {@link openPageSeoWrite}: one snapshot
 * header for all of them, on the caller's branch in a chat (the live row
 * untouched), else on main after writing the live rows.
 */
export async function commitPageSeoWrites(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  input: readonly { readonly opened: OpenedPageSeo; readonly next: PageSeoState }[],
  opKind: SnapshotOpKind,
  description: string,
): Promise<void> {
  if (input.length === 0) return;
  // Asset ids in a state are canonical (the ops normalize them; this keeps
  // any caller from storing an uppercase id every comparison would miss).
  // #1752 — every own text records who wrote it.
  const author = seoAuthorOf(ctx);
  const writes = input.map((w) => ({
    opened: w.opened,
    next: {
      ...w.next,
      ogImageAssetId: assetKey(w.next.ogImageAssetId),
      nosnippetContent: [...new Set(w.next.nosnippetContent.map(uuidKey))].sort(),
      origins: authorshipAfterWrite(w.opened.current, w.next, author),
    },
  }));
  await assertOgImagesUsable(
    tx,
    writes
      .filter(
        (w) =>
          w.next.ogImageAssetId !== null &&
          w.next.ogImageAssetId !== w.opened.current.ogImageAssetId,
      )
      .map((w) => w.next.ogImageAssetId as string),
  );
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

/**
 * A new OG image must be a library image that can ship on a page. The live
 * row's foreign key checked existence only when SEO was written live; a
 * chat's SEO now lands in snapshot JSON, so the check happens here, for
 * both paths, before anything is written (thrown: the write and any lock
 * takeover roll back). Soft-deleted assets are refused too — a page would
 * render no og:image for them.
 */
async function assertOgImagesUsable(
  tx: TransactionRunner,
  assetIds: readonly string[],
): Promise<void> {
  if (assetIds.length === 0) return;
  const unique = [...new Set(assetIds.map(uuidKey))];
  const rows = (await tx.execute(sql`
    SELECT id::text AS id FROM media_assets
    WHERE id = ANY(${uuidArray(unique)}) AND deleted_at IS NULL AND visibility = 'library'
  `)) as unknown as { id: string }[];
  const found = new Set(rows.map((r) => r.id));
  const bad = unique.filter((id) => !found.has(id));
  if (bad.length === 0) return;
  throw new OperationAbortError({
    kind: "HandlerError",
    operation: "pages_seo",
    message:
      `ogImageAssetId ${bad.join(", ")} is not a usable library image (unknown, deleted, or a generation reference) — ` +
      "nothing was written. Take the id of an image from find_media (or import one with import_media_from_urls), or pass null to remove the OG image, and call again.",
  });
}
