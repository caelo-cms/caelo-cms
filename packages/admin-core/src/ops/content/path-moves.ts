// SPDX-License-Identifier: MPL-2.0

/**
 * The side effects of a page URL move — ONE implementation for every
 * cause: a slug change, a reparent / subtree move, a chat's moves going
 * live at publish, a plugin URL-shape change, a revert.
 *
 * A move is never just a column write: the old URL must keep working
 * (301), redirects that pointed at the old URL must not become chains,
 * and a redirect sitting on the page's NEW URL must yield to the page.
 * All of it runs on the caller's transaction, so the move commits or
 * rolls back as a whole (CLAUDE.md §11: a multi-step patch belongs
 * inside one op).
 *
 * #1550 — and none of it touches the live redirects. Each effect is an
 * AUTOMATIC pending change (always Staged, `redirects/write.ts`): the 301,
 * the chain collapse and the take-over of the rule on the new URL go live
 * with the Publish live that ships the page change (closes #1521). Until
 * then the live site keeps serving the previous build with its redirects,
 * and staging serves the changes against the staged build: a 301 to a URL
 * the staged build does not have yet waits for the next Stage, and so does
 * the take-over of a URL the build does not serve the page at yet
 * (`planRedirectRelease`).
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
 * #1517 — only for pages that are on the main line. A page only a chat's
 * branch holds (created or duplicated there, never merged) has no public
 * URL: its old path was never served, so it gets no 301, and its new path
 * is not served either, so a rule there keeps answering on the live site.
 * Such a move only stores the path; the rule on the new URL is taken over
 * when the page is first shipped by Publish live
 * (`takeOverRedirectsOnFirstPublishedPages`, redirects/release.ts), and the
 * write tools name it meanwhile (`redirects.page_conflicts`).
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { type ExecutionContext, redirectAddress } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  pendingByAddress,
  type RedirectOrigin,
  SHARED_DRAFT_PENDING,
} from "../../redirects/model.js";
import { type RedirectChangeInput, writeRedirectChanges } from "../../redirects/write.js";
import type { PathMove } from "./current-path.js";

/** What a move set changed besides the paths themselves. */
export interface PathMoveEffects {
  /** Old-URL 301s staged (one per moved page unless suppressed). */
  readonly redirectsCreated: number;
}

/**
 * The rules a move's chain collapse retargets: every rule of the pending
 * view (a live rule nobody changes, or a pending create / change) whose
 * target is one of `oldPaths`. Served by `redirects_to_path_idx` (#1291)
 * and `pending_redirects_to_path_idx` — it runs on every page move and
 * slug change, so a scan of either table here grows with the site.
 * Exported so the plan test checks this exact statement.
 */
export function rulesPointingAtSql(oldPaths: readonly string[]): SQL {
  const targets = textArray([...oldPaths]);
  return sql`
    SELECT caelo_redirect_address(r.from_path) AS address, r.from_path, r.to_path, r.status_code
    FROM redirects r
    WHERE r.to_path = ANY(${targets})
      AND NOT EXISTS (
        SELECT 1 FROM pending_redirects p WHERE p.address = caelo_redirect_address(r.from_path)
      )
    UNION ALL
    SELECT p.address, p.from_path, p.to_path, p.status_code
    FROM pending_redirects p
    WHERE p.to_path = ANY(${targets}) AND ${SHARED_DRAFT_PENDING}
  `;
}

/**
 * #1517 — the pages of `pageIds` only a chat's branch holds
 * (`chat_branch_id` set until the merge takes them to main). Such a page
 * was never served, so no page write may write a redirect change for it
 * (see the module comment): every page-driven redirect write asks here
 * first (`scripts/no-draft-live-writes.test.ts` pins them).
 */
export async function branchOnlyPageIds(
  tx: TransactionRunner,
  pageIds: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();
  const rows = (await tx.execute(sql`
    SELECT id::text AS id FROM pages
    WHERE id = ANY(${uuidArray([...pageIds])}) AND chat_branch_id IS NOT NULL
  `)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** The moves of pages on the main line (#1517, {@link branchOnlyPageIds}). */
async function mainLineMoves(
  tx: TransactionRunner,
  moves: ReadonlyArray<PathMove>,
): Promise<PathMove[]> {
  const skipped = await branchOnlyPageIds(
    tx,
    moves.map((m) => m.pageId),
  );
  return moves.filter((m) => !skipped.has(m.pageId));
}

/**
 * Stage the redirect side effects of already-persisted path moves.
 *
 * @param redirects `"skip"` suppresses the old-URL 301s (operator asked
 *   for the old URLs to 404); `{ skip }` decides per moved page (a publish
 *   carrying moves with different requests). Chain collapse and reclaim
 *   always run over the WHOLE move set in one pass — split passes would
 *   re-collapse one subset's fresh redirects.
 * @param origin what caused the moves, recorded on the automatic changes
 *   (a slug change or move is `page_move`, a revert `revert`).
 */
export async function applyPathMoveEffects(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  moves: ReadonlyArray<PathMove>,
  redirects: "auto" | "skip" | { readonly skip: (pageId: string) => boolean },
  origin: Extract<RedirectOrigin, "page_move" | "revert"> = "page_move",
): Promise<PathMoveEffects> {
  const skipsRedirect = (pageId: string): boolean =>
    redirects === "skip" ? true : redirects === "auto" ? false : redirects.skip(pageId);
  const real = await mainLineMoves(
    tx,
    moves.filter((m) => m.from !== m.to),
  );
  if (real.length === 0) return { redirectsCreated: 0 };
  const changes: RedirectChangeInput[] = [];

  // A page now lives at each new path: a rule there (e.g. left by an
  // earlier move away, now moved back) would shadow it — remove it BEFORE
  // collapsing chains, or "new → old" would collapse into a self-loop.
  // #1447 — both spellings: one address.
  const newAddresses = new Set(real.map((m) => redirectAddress(m.to)));
  const atNew = await pendingByAddress(tx, [...newAddresses]);
  const liveAtNew = (await tx.execute(sql`
    SELECT DISTINCT caelo_redirect_address(from_path) AS address FROM redirects
    WHERE caelo_redirect_address(from_path) = ANY(${textArray([...newAddresses])})
  `)) as unknown as { address: string }[];
  const ruledAtNew = new Set([
    ...liveAtNew.map((r) => r.address),
    ...[...atNew.values()].filter((p) => p.toPath !== null).map((p) => p.address),
  ]);
  for (const m of real) {
    if (ruledAtNew.has(redirectAddress(m.to))) {
      changes.push({ fromPath: m.to, toPath: null, statusCode: null });
    }
  }

  // Collapse chains: X → old becomes X → new, so a visitor hops once.
  // ONE read against the original targets: with chained or swapped moves
  // (/a → /b, /b → /c) sequential updates would carry "/legacy → /a" on to
  // /c, i.e. to the wrong page.
  const newPathOf = new Map(real.map((m) => [m.from, m.to]));
  const pointing = (await tx.execute(rulesPointingAtSql([...newPathOf.keys()]))) as unknown as {
    address: string;
    from_path: string;
    to_path: string;
    status_code: number;
  }[];
  for (const r of pointing) {
    const to = newPathOf.get(r.to_path);
    // A rule on a new path is being removed above; never point it anywhere.
    if (to === undefined || newAddresses.has(r.address)) continue;
    changes.push({ fromPath: r.from_path, toPath: to, statusCode: r.status_code });
  }

  // The old URLs' 301s last: a later change of an address replaces an
  // earlier one of the same write (the collapse of a rule that is itself
  // an old URL of this move set).
  let redirectsCreated = 0;
  for (const m of real) {
    if (skipsRedirect(m.pageId)) continue;
    // Two pages swapping URLs: the old URL is another page's new home.
    if (newAddresses.has(redirectAddress(m.from))) continue;
    changes.push({ fromPath: m.from, toPath: m.to, statusCode: 301 });
    redirectsCreated += 1;
  }
  await writeRedirectChanges(tx, changes, {
    origin,
    state: "staged",
    // Main-line effects: the shared draft's, owned by no chat (an Undo of
    // a chat never undoes a page change that is already on the main line).
    owner: { actorId: ctx.actorId, chatSessionId: null, chatBranchId: null },
  });
  return { redirectsCreated };
}
