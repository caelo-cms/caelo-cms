// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — the link targets one scope can see: every live page with
 * its public path and status, and every live media asset. ONE loader for
 * the three consumers of internal references in admin-core:
 *
 *   - render: the editor preview's {@link SiteLinkIndex} (rollout B);
 *   - write: the canonicaliser that turns `/about` into
 *     `caelo:page/<id>` at the write boundary (rollout C);
 *   - read: humanising references back into paths for tool results and
 *     editor fields (rollout C).
 *
 * All three must agree on which page `/about` is, so all three derive it
 * through {@link linkTargetPagesOf}. Branch view: under a chat branch the
 * chat sees main plus its own created pages, with its pending page edits
 * (rename, move, status, delete) overlaid — the same view `pages.list`
 * gives the chat, so a link the chat writes to a page it just renamed
 * resolves to that page.
 *
 * The preview reads the rows through its cached site view (#1212) and
 * asks the plugins for a pending move's path while it holds no
 * transaction; the write and read paths load them here.
 */

import type { RenderScope, ResolvedLinkVariants } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  createSiteLinkIndex,
  type LinkIndexMedia,
  type LinkIndexPage,
  type LinkRenderEnv,
  type PageUrlStyle,
  type SiteLinkIndex,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { loadPageRows, type PageRows } from "../lists/pages-view.js";
import { composePaths, composePathsOutsideTransaction } from "../ops/content/compose-paths.js";
import { driftIdsBetween, pageTreeOf } from "../ops/content/page-tree.js";
import type { SiteView } from "../site-view.js";

/** A page as link canonicalisation and humanising need it. */
export interface LinkTargetPage extends LinkIndexPage {
  readonly title: string;
}

/** Everything a scope can link to. */
export interface LinkTargets {
  readonly pages: readonly LinkTargetPage[];
  readonly media: readonly LinkIndexMedia[];
}

/**
 * The link-target pages of `rows`: live (non-deleted) rows with the
 * branch's pending title / status / delete applied, at their stored path
 * or, for a page a pending rename or move changes, at `driftPaths`.
 */
export function linkTargetPagesOf(
  { rows, pending }: PageRows,
  driftPaths: ReadonlyMap<string, string>,
): LinkTargetPage[] {
  const out: LinkTargetPage[] = [];
  for (const r of rows) {
    if (r.deleted_at !== null) continue;
    const s = pending.get(r.id);
    if (s?.deletedAt) continue;
    out.push({
      id: r.id,
      path: driftPaths.get(r.id) ?? r.current_path,
      title: s?.title ?? r.title,
      status: s?.status ?? r.status,
    });
  }
  return out;
}

/**
 * Load the link targets visible to `chatBranchId` (null = main).
 *
 * Two small queries plus, only when the branch has pending renames or
 * moves, one path composition for the drifted pages — the same shape
 * `pages.list` uses for its branch view.
 */
export async function loadLinkTargets(
  tx: TransactionRunner,
  chatBranchId: string | null,
): Promise<LinkTargets> {
  const pageRows = await loadPageRows(tx, chatBranchId);
  let driftPaths: ReadonlyMap<string, string> = new Map();
  if (chatBranchId && pageRows.pending.size > 0) {
    // A rename or move changes the path of the page and everything below
    // it, recomposed from the branch's tree.
    const live = pageRows.rows.filter((r) => r.deleted_at === null);
    const tree = pageTreeOf(live, pageRows.pending);
    const drifted = driftIdsBetween(tree, pageTreeOf(live, new Map()));
    if (drifted.length > 0) driftPaths = await composePaths(tx, tree, drifted, { chatBranchId });
  }
  const media = (await tx.execute(sql`
    SELECT id::text AS id, slug FROM media_assets WHERE deleted_at IS NULL
  `)) as unknown as LinkIndexMedia[];
  return { pages: linkTargetPagesOf(pageRows, driftPaths), media };
}

/**
 * Issue #1212 — the paths a branch's pending renames and moves give its
 * pages, composed from the site view's tree. Asks the URL plugins for
 * their annotations, so call it with no transaction held. Empty when
 * nothing drifted (no plugin call then).
 */
export async function siteViewDriftPaths(
  view: SiteView,
  renderScope: RenderScope,
): Promise<ReadonlyMap<string, string>> {
  if (view.driftedIds.length === 0) return new Map();
  return composePathsOutsideTransaction(
    view.tree,
    view.driftedIds,
    view.settings.homePageId,
    renderScope,
  );
}

/**
 * Build the render-time link index for a preview: the site view's link
 * targets plus the link-resolve composition point's page-variant
 * partition (rollout D), asked by the caller with the render's branch
 * scope so a page the chat just created as a German version maps like a
 * published one. The static generator builds its twin in `link-index.ts`.
 */
export function previewLinkIndexOf(input: {
  readonly view: SiteView;
  readonly driftPaths: ReadonlyMap<string, string>;
  readonly pageVariants: ResolvedLinkVariants | undefined;
  readonly env: LinkRenderEnv;
  readonly pageUrlStyle: PageUrlStyle;
}): SiteLinkIndex {
  return createSiteLinkIndex({
    pages: linkTargetPagesOf(input.view.pageRows, input.driftPaths),
    media: input.view.media,
    env: input.env,
    pageUrlStyle: input.pageUrlStyle,
    ...(input.pageVariants ? { pageVariants: input.pageVariants } : {}),
  });
}
