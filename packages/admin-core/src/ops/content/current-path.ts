// SPDX-License-Identifier: MPL-2.0

/**
 * #390 — `pages.current_path` recompute at the write boundary.
 *
 * The composed public path is MATERIALIZED: every op that can change a
 * page's URL shape (create, slug update, duplicate, home-designation
 * flip) recomputes the affected rows inside its own transaction, so
 * render-time consumers read one column and the URL-diff engine can
 * compare stored paths against fresh resolutions even after the
 * contributing plugin is gone.
 *
 * Resolution = the plugin-host composition point: an I/O phase collects
 * each contributing plugin's per-page annotations, then the pure
 * resolver composes. With no URL plugins active this degrades to
 * "/<slug>" (home → "/") — the same shape the 0211 backfill wrote.
 */

import {
  collectUrlAnnotations,
  hostSystemActorId,
  type RenderScope,
  resolvePageUrl,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, isHomeSlug, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { createRedirectOp } from "../redirects.js";

interface PageRowForPath {
  id: string;
  slug: string;
}

/**
 * Home predicate for PATH COMPOSITION: an explicit designation wins
 * outright — magic slugs ("", home, index) act as the root only when NO
 * designation exists. (isDesignatedHomePage's OR-shape is right for
 * "should this render as the root?" consumers, but composing paths with
 * it would let a magic-slug page and a designated page both claim "/",
 * violating the current_path uniqueness the whole point rests on.)
 */
function isCompositionHome(
  pageId: string,
  slug: string,
  designatedHomePageId: string | null,
  annotations: Record<string, unknown>,
): boolean {
  // A URL plugin may declare this page the root of its own URL space.
  // The site has ONE designated home, but a multilingual site has one
  // per locale, and core cannot derive the others — it has no locale
  // concept (epic #380). The `international-site` plugin answers it
  // from the variant group; without this the German home composes to
  // `/de/<slug>` instead of `/de/`, and the only workaround available
  // to a caller is duplicating the sentinel slug, which the site-wide
  // slug uniqueness refuses.
  //
  // Uniqueness still holds: each locale root carries a different path
  // prefix, so `/` and `/de` never collide.
  if (annotations.isLocaleRoot === true) return true;
  if (designatedHomePageId !== null) return pageId === designatedHomePageId;
  return isHomeSlug(slug);
}

async function loadDesignatedHomePageId(tx: TransactionRunner): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { home_page_id: string | null }[];
  return rows[0]?.home_page_id ?? null;
}

type PathRow = PageRowForPath & { readonly chat_branch_id: string | null };

/** The render scope a write runs in: its chat branch, or main. */
export function renderScopeOf(ctx: ExecutionContext): RenderScope {
  return { chatBranchId: ctx.chatBranchId ?? null };
}

/**
 * Recompute `current_path` for the given pages under `scope`, and persist
 * it where that scope owns the row. Plugin URL annotations can live on a
 * chat branch (e.g. a variant link written in a chat), so a branch
 * composes with its own plugin state:
 *
 * - main scope persists every given row (existing behaviour);
 * - a branch scope persists only rows that branch created — a main
 *   row's live path must not move before publish. The merge recomputes
 *   main-line paths once the branch's plugin rows are live
 *   ({@link refreshLivePathsAfterMerge}).
 *
 * @returns the composed path per page, persisted or not.
 */
export async function recomputeCurrentPaths(
  tx: TransactionRunner,
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniqueIds = [...new Set(pageIds)];
  if (uniqueIds.length === 0) return out;

  const idList = sql.join(
    uniqueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const fetched = (await tx.execute(sql`
    SELECT id::text AS id, slug, chat_branch_id::text AS chat_branch_id
    FROM pages WHERE id IN (${idList})
  `)) as unknown as PathRow[];
  if (fetched.length === 0) return out;
  // Preserve the caller's order — vacating the current "/" holder
  // BEFORE assigning the new one is load-bearing for the uniqueness
  // index (pages.set_home_page passes [oldHolders..., newHome]).
  const byId = new Map(fetched.map((r) => [r.id, r]));
  const rows = uniqueIds.map((id) => byId.get(id)).filter((r): r is PathRow => r !== undefined);

  const designated = await loadDesignatedHomePageId(tx);
  // current_path is live, main-line state: annotate from main, never from
  // a chat's branch rows.
  const annotations = await collectUrlAnnotations(
    rows.map((r) => r.id),
    scope,
  );

  for (const row of rows) {
    const resolved = resolvePageUrl({
      pageId: row.id,
      slug: row.slug,
      isHomePage: isCompositionHome(row.id, row.slug, designated, annotations.get(row.id) ?? {}),
      annotations: annotations.get(row.id) ?? {},
    });
    out.set(row.id, resolved.path);
    if (scope.chatBranchId !== null && row.chat_branch_id !== scope.chatBranchId) continue;
    await tx.execute(sql`
      UPDATE pages SET current_path = ${resolved.path} WHERE id = ${row.id}::uuid
    `);
  }
  return out;
}

/**
 * Resolve WITHOUT persisting — the diff engine's "what would the paths
 * be" half. Same I/O + composition as the recompute.
 */
export async function resolveCurrentPathsDryRun(
  tx: TransactionRunner,
  pages: ReadonlyArray<PageRowForPath>,
  scope: RenderScope,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pages.length === 0) return out;
  const designated = await loadDesignatedHomePageId(tx);
  const annotations = await collectUrlAnnotations(
    pages.map((r) => r.id),
    scope,
  );
  for (const row of pages) {
    const resolved = resolvePageUrl({
      pageId: row.id,
      slug: row.slug,
      isHomePage: isCompositionHome(row.id, row.slug, designated, annotations.get(row.id) ?? {}),
      annotations: annotations.get(row.id) ?? {},
    });
    out.set(row.id, resolved.path);
  }
  return out;
}

/**
 * #396 — refresh one page's composed path after PLUGIN DATA changed its
 * URL shape (a variant link/unlink changes the locale annotation and
 * with it the prefix). Bounded to ONE page, undoable by the inverse
 * data change, so it stays routine (§11.A test) — unlike a
 * contribution-SET change, which fans out site-wide and goes through
 * propose_url_migration. When the path moves, the old URL gets the
 * same 301 treatment a slug change gets.
 */
export const refreshCurrentPathOp = defineOperation({
  name: "pages.refresh_current_path",
  // Plugins call this after writing variant rows; the AI/system may
  // call it when repairing drift. Never destructive: recompute + 301.
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      redirectFromOld: z.enum(["auto", "skip"]).default("auto"),
    })
    .strict(),
  output: z.object({
    path: z.string(),
    moved: z.boolean(),
  }),
  handler: async (ctx, input, tx) => {
    const before = (await tx.execute(sql`
      SELECT current_path, slug, chat_branch_id::text AS chat_branch_id
      FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL
    `)) as unknown as { current_path: string; slug: string; chat_branch_id: string | null }[];
    const oldPath = before[0]?.current_path;
    if (oldPath === undefined) {
      return err({
        kind: "HandlerError",
        operation: "pages.refresh_current_path",
        message: "page not found or deleted",
      });
    }
    const scope = renderScopeOf(ctx);
    const row = before[0];
    if (row && scope.chatBranchId !== null && row.chat_branch_id !== scope.chatBranchId) {
      // A main page refreshed from a chat: its live URL must not move
      // before publish. Report the branch's view; the merge applies it.
      const preview = await resolveCurrentPathsDryRun(
        tx,
        [{ id: input.pageId, slug: row.slug }],
        scope,
      );
      const path = preview.get(input.pageId) ?? oldPath;
      return ok({ path, moved: false });
    }
    const recomputed = await recomputeCurrentPaths(tx, [input.pageId], scope);
    const newPath = recomputed.get(input.pageId);
    if (!newPath) {
      return err({
        kind: "HandlerError",
        operation: "pages.refresh_current_path",
        message: "recompute returned no path — page vanished mid-transaction",
      });
    }
    const moved = newPath !== oldPath;
    if (moved && input.redirectFromOld !== "skip") {
      const red = await createRedirectOp.handler(
        ctx,
        { fromPath: oldPath, toPath: newPath, statusCode: 301 },
        tx,
      );
      if (!red.ok) {
        throw new Error(
          `refresh_current_path aborted — redirect ${oldPath} → ${newPath} failed to land`,
        );
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.refresh_current_path",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: moved ? `${oldPath} → ${newPath}` : "unchanged",
    });
    return ok({ path: newPath, moved });
  },
});

/**
 * Recompose every live page's path on main after a merge made a branch's
 * plugin rows live, and 301 the pages that moved — the main-line half of
 * what `pages.refresh_current_path` deferred while the change sat on the
 * branch. Annotations come only from plugins, so callers run this only
 * when plugin rows were merged.
 *
 * Plugin calls run in their own transactions and cannot see the merge's
 * uncommitted writes. The annotations are therefore read in the BRANCH
 * view — committed main plus the branch overlay — which is exactly the
 * post-merge state when the merge takes every plugin row the branch
 * holds (the caller guarantees that).
 *
 * @returns the pages whose live path moved.
 */
export async function refreshLivePathsAfterMerge(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  chatBranchId: string,
): Promise<string[]> {
  // Without the plugin host loaded no URL plugin would answer, and every
  // prefixed path (/de/…) would recompose bare. Fail rather than strip.
  hostSystemActorId();
  const live = (await tx.execute(sql`
    SELECT id::text AS id, slug, current_path FROM pages
    WHERE deleted_at IS NULL AND chat_branch_id IS NULL
  `)) as unknown as { id: string; slug: string; current_path: string }[];
  if (live.length === 0) return [];
  const composed = await resolveCurrentPathsDryRun(
    tx,
    live.map((p) => ({ id: p.id, slug: p.slug })),
    { chatBranchId },
  );
  // The redirects are main-line state, like the paths they follow.
  const { chatBranchId: _branch, chatTaskId: _task, ...mainCtx } = ctx;
  const moved = live.filter((p) => {
    const next = composed.get(p.id);
    return next !== undefined && next !== p.current_path;
  });
  // Vacate before claiming: two pages may swap paths, and current_path
  // is unique.
  for (const page of moved) {
    await tx.execute(sql`
      UPDATE pages SET current_path = ${`${page.current_path}#moving-${page.id}`}
      WHERE id = ${page.id}::uuid
    `);
  }
  for (const page of moved) {
    const newPath = composed.get(page.id) as string;
    await tx.execute(sql`UPDATE pages SET current_path = ${newPath} WHERE id = ${page.id}::uuid`);
    const red = await createRedirectOp.handler(
      mainCtx,
      { fromPath: page.current_path, toPath: newPath, statusCode: 301 },
      tx,
    );
    if (!red.ok) {
      throw new Error(
        `merge: redirect ${page.current_path} → ${newPath} failed to land after a plugin URL change`,
      );
    }
  }
  return moved.map((p) => p.id);
}
