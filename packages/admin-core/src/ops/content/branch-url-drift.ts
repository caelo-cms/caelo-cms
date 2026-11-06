// SPDX-License-Identifier: MPL-2.0

/**
 * #1411 — the URLs a chat's plugin rows change without a page snapshot.
 *
 * A page's URL has two inputs: the tree (slug, parent) and the annotations
 * of the URL plugins. A pending rename or move shows in the draft head as
 * a page; a pending plugin row (a locale variant linked in a chat) shows
 * as a `pluginRow` that names the page, and a main page's stored
 * `current_path` only moves at the merge. So every branch view of a page
 * asks two things of the head: was the page moved
 * (`page-tree.ts`), and does a pending row of a URL plugin name it (here).
 *
 * The second answer only makes the page a candidate: most pending rows of
 * a URL plugin leave the URL alone (a translation status, say). A candidate
 * is composed with the branch's plugin state and with main's over the same
 * tree, and only a difference is the branch's: a page whose main composition
 * differs from its stored path but matches the branch's is waiting for a URL
 * migration (#586), and that is no change of this chat's.
 *
 * A row names a page through its `page_id` column (migration 0648). A row
 * that names none, such as a site-wide URL setting, moves pages through
 * the URL migration, not through a chat. A page the branch created is no
 * candidate: `pages.refresh_current_path` persists its stored path, which
 * is what keeps a translation sprint of new variants from composing them
 * all in every view.
 */

import { urlAnnotationPluginSlugs } from "@caelo-cms/plugin-host";
import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { composePaths } from "./compose-paths.js";
import type { PageTree } from "./page-tree.js";

/**
 * The main-line pages a pending row of an active URL plugin names on
 * `branchId` (null = main, which has no pending rows): the candidates for a
 * branch URL. Costs no statement while no URL plugin runs.
 *
 * @param pageIds narrows the answer to these pages. Leave it out only in a
 *   view of the whole site: the read is then as large as the branch's
 *   pending rows.
 */
export async function pendingUrlAnnotationPageIds(
  tx: TransactionRunner,
  branchId: string | null,
  pageIds?: readonly string[],
): Promise<string[]> {
  const slugs = urlAnnotationPluginSlugs();
  if (branchId === null || slugs.length === 0 || pageIds?.length === 0) return [];
  const named = pageIds ? sql`AND d.page_id = ANY(${uuidArray([...new Set(pageIds)])})` : sql``;
  const rows = (await tx.execute(sql`
    SELECT DISTINCT d.page_id::text AS id
      FROM draft_pending_entities d
      JOIN plugins pl ON pl.id = d.plugin_id
      JOIN pages p ON p.id = d.page_id
     WHERE d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'pluginRow'
       AND d.page_id IS NOT NULL ${named}
       AND pl.slug = ANY(${textArray(slugs)})
       AND p.chat_branch_id IS NULL
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * The pages of `branchPaths` that compose differently from `livePaths`,
 * at their branch path: the pure half of {@link annotationDriftPaths},
 * shared with the preview, which composes outside a transaction.
 */
export function annotationDriftOf(
  branchPaths: ReadonlyMap<string, string>,
  livePaths: ReadonlyMap<string, string>,
): Map<string, string> {
  return new Map([...branchPaths].filter(([id, path]) => livePaths.get(id) !== path));
}

/**
 * The branch paths of `candidates` ({@link pendingUrlAnnotationPageIds})
 * whose URL the branch's plugin rows change. Asks the plugins twice, and
 * only for the candidates, so it costs nothing for a page no row names.
 *
 * @param tree the branch's view of at least the candidates' chains; both
 *   compositions use it, so a difference is the plugins' alone.
 */
export async function annotationDriftPaths(
  tx: TransactionRunner,
  tree: PageTree,
  candidates: readonly string[],
  branchId: string,
): Promise<Map<string, string>> {
  if (candidates.length === 0) return new Map();
  const branchPaths = await composePaths(tx, tree, candidates, { chatBranchId: branchId });
  const livePaths = await composePaths(tx, tree, candidates, { chatBranchId: null });
  return annotationDriftOf(branchPaths, livePaths);
}
