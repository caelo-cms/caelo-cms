// SPDX-License-Identifier: MPL-2.0

/**
 * The side effects of a page URL move — ONE implementation for every
 * cause: a slug change, a reparent / subtree move, a chat's moves going
 * live at publish, a plugin URL-shape change.
 *
 * A move is never just a column write: the old URL must keep working
 * (301), redirects that pointed at the old URL must not become chains,
 * and a redirect sitting on the page's NEW URL must yield to the page.
 * All of it runs on the caller's transaction, so the move commits or
 * rolls back as a whole (CLAUDE.md §11: a multi-step patch belongs
 * inside one op).
 *
 * No stored link is touched (epic #724). Internal links are page
 * references (`caelo:page/<id>`) that resolve to the page's current path
 * at render time, so nav menus, link lists, module HTML and content
 * follow a move on their own. The 301s exist for links from OUTSIDE the
 * site (search engines, bookmarks, other sites). A literal internal link
 * left over from before #724 that the one-time migration could not turn
 * into a reference is NOT rewritten either: it keeps working through the
 * 301 and the link checks report it, so it is fixed visibly, never
 * guessed.
 *
 * Always main-line: callers pass a context without a chat branch —
 * redirects are live state, like the paths they follow.
 *
 * #1517 — and therefore only for pages that are on the main line. A page
 * only a chat's branch holds (created or duplicated there, never merged)
 * has no public URL: its old path was never served, so it gets no 301, and
 * its new path is not served either, so a rule there keeps answering on
 * the live site. Such a move only stores the path; the rule on the new URL
 * is taken over when the page is first shipped by Publish live
 * ({@link takeOverRedirectsOnFirstPublishedPages}), and the write tools
 * name it meanwhile (`redirects.page_conflicts`).
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { type ExecutionContext, redirectFromPathSpellings } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { requestRedirectSync } from "../../deploy/redirect-sync.js";
import { createRedirectOp } from "../redirects.js";
import type { PathMove } from "./current-path.js";

/** What a move set changed besides the paths themselves. */
export interface PathMoveEffects {
  /** Old-URL 301s created (one per moved page unless suppressed). */
  readonly redirectsCreated: number;
}

/**
 * The chain-collapse statement of a move set: every redirect that pointed
 * at a moved page's old path now points at its new one. Served by
 * `redirects_to_path_idx` (#1291) — it runs on every page move and slug
 * change, so a scan of the redirects table here grows with the site.
 * Exported so the plan test checks this exact statement.
 */
export function collapseRedirectChainsSql(moves: ReadonlyArray<Pick<PathMove, "from" | "to">>) {
  return sql`
    UPDATE redirects r SET to_path = m.new_path
    FROM (VALUES ${sql.join(
      moves.map((m) => sql`(${m.from}, ${m.to})`),
      sql`, `,
    )}) AS m(old_path, new_path)
    WHERE r.to_path = m.old_path
    RETURNING 1 AS collapsed
  `;
}

/**
 * The moves of pages on the main line: a page a chat's branch holds
 * (`chat_branch_id` set until the merge takes it live) moves without live
 * effects (#1517, see the module comment).
 */
async function mainLineMoves(
  tx: TransactionRunner,
  moves: ReadonlyArray<PathMove>,
): Promise<PathMove[]> {
  if (moves.length === 0) return [];
  const branchOnly = (await tx.execute(sql`
    SELECT id::text AS id FROM pages
    WHERE id = ANY(${uuidArray(moves.map((m) => m.pageId))}) AND chat_branch_id IS NOT NULL
  `)) as unknown as { id: string }[];
  if (branchOnly.length === 0) return [...moves];
  const skipped = new Set(branchOnly.map((r) => r.id));
  return moves.filter((m) => !skipped.has(m.pageId));
}

/**
 * #1517 — Publish live takes a page's URL over from a redirect rule: the
 * pages a production build ships for the first time (`pageIds`, stamped
 * `first_published_at` by that release) delete every rule on their path, in
 * both spellings, in the release's transaction. Until then the rule kept
 * answering on the live site, which did not serve the page yet; the build
 * that now serves it wins over the rule anyway (the redirect plan leaves a
 * served path out), so the delete only keeps the rule from coming back when
 * the page leaves the build. Not at the merge (Stage): the live site serves
 * the previous build until Publish live, and a rule deleted at Stage would
 * leave the URL answering 404 there.
 *
 * The caller pushes the table after its commit (the release's own redirect
 * sync); a request is registered too, for the targets that release does not
 * push.
 *
 * @returns how many rules were deleted.
 */
export async function takeOverRedirectsOnFirstPublishedPages(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  pages: ReadonlyArray<{ readonly id: string; readonly path: string }>,
): Promise<number> {
  if (pages.length === 0) return 0;
  // The 404 page is served at /404.html: its own path is free for a rule.
  const designated = (await tx.execute(sql`
    SELECT not_found_page_id::text AS id FROM site_defaults WHERE id = 1
  `)) as unknown as { id: string | null }[];
  const notFound = designated[0]?.id ?? null;
  const spellings = pages
    .filter((p) => p.id !== notFound)
    .flatMap((p) => redirectFromPathSpellings(p.path));
  if (spellings.length === 0) return 0;
  const gone = (await tx.execute(sql`
    DELETE FROM redirects WHERE from_path = ANY(${textArray(spellings)})
    RETURNING 1 AS gone
  `)) as unknown as { gone: number }[];
  if (gone.length > 0) await requestRedirectSync(tx, ctx);
  return gone.length;
}

/**
 * Apply the side effects of already-persisted path moves.
 *
 * @param redirects `"skip"` suppresses the old-URL 301s (operator asked
 *   for the old URLs to 404); `{ skip }` decides per moved page (a publish
 *   carrying moves with different requests). Chain collapse and reclaim
 *   always run over the WHOLE move set in one pass — split passes would
 *   re-collapse one subset's fresh redirects.
 */
export async function applyPathMoveEffects(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  moves: ReadonlyArray<PathMove>,
  redirects: "auto" | "skip" | { readonly skip: (pageId: string) => boolean },
): Promise<PathMoveEffects> {
  const skipsRedirect = (pageId: string): boolean =>
    redirects === "skip" ? true : redirects === "auto" ? false : redirects.skip(pageId);
  const real = await mainLineMoves(
    tx,
    moves.filter((m) => m.from !== m.to),
  );
  if (real.length === 0) return { redirectsCreated: 0 };
  const { chatBranchId: _b, chatTaskId: _t, ...mainCtx } = ctx;

  // A page now lives at each new path: a redirect from there (e.g. left
  // by an earlier move away, now moved back) would shadow it — drop it
  // BEFORE collapsing chains, or "new → old" would collapse into a
  // self-loop. #1447 — both spellings: a row answers its path with and
  // without the trailing slash, and an imported table stores `/old/`.
  const newPaths = new Set(real.map((m) => m.to));
  // #1254 — counted: only a move that changed redirect rows asks for a sync.
  let redirectRowsChanged = 0;
  for (const m of real) {
    const gone = (await tx.execute(sql`
      DELETE FROM redirects WHERE from_path = ANY(${textArray(redirectFromPathSpellings(m.to))})
      RETURNING 1 AS gone
    `)) as unknown as { gone: number }[];
    redirectRowsChanged += gone.length;
  }
  // Collapse chains: X → old becomes X → new, so a visitor hops once.
  // ONE statement against the original targets: with chained or swapped
  // moves (/a → /b, /b → /c) sequential updates would carry "/legacy →
  // /a" on to /c, i.e. to the wrong page.
  const collapsed = (await tx.execute(collapseRedirectChainsSql(real))) as unknown as {
    collapsed: number;
  }[];
  redirectRowsChanged += collapsed.length;
  let redirectsCreated = 0;
  for (const m of real) {
    if (skipsRedirect(m.pageId)) continue;
    // Two pages swapping URLs: the old URL is another page's new home.
    if (newPaths.has(m.from)) continue;
    const red = await createRedirectOp.handler(
      mainCtx,
      { fromPath: m.from, toPath: m.to, statusCode: 301 },
      tx,
    );
    // Loud: a move whose 301 failed is exactly the state that strands
    // inbound links, so it aborts the whole transaction.
    if (!red.ok) throw new Error(`page move aborted — redirect ${m.from} → ${m.to} failed`);
    redirectsCreated += 1;
  }

  // #1157 — the deletes and chain updates above changed the redirects table
  // too (each created 301 already asked for the sync itself). #1254 — a move
  // that changed no redirect row asks for nothing: the sync runs off the
  // write path and only when the table changed (deploy/redirect-sync.ts).
  if (redirectRowsChanged > 0) await requestRedirectSync(tx, ctx);
  return { redirectsCreated };
}
