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
import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import {
  createSiteLinkIndex,
  type LinkHumaniseLookup,
  type LinkIndexMedia,
  type LinkIndexPage,
  type LinkRef,
  type LinkRenderEnv,
  type PageUrlStyle,
  type SiteLinkIndex,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { headOverlaySql } from "../draft.js";
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
 * #1269 — the humanise lookup for exactly the pages and media `refs`
 * name, as `chatBranchId` sees them: the same paths {@link loadLinkTargets}
 * gives those pages, at the cost of the references, not the site.
 *
 * A page's stored `current_path` is its branch path unless the page or a
 * page above it has a pending rename or move on the branch (a pending
 * slug or parent that differs from the live row): only then is the path
 * composed, through the full branch view. A pending delete hides the
 * page; a page the caller cannot see, or a deleted medium, stays raw.
 */
export async function loadHumaniseLookup(
  tx: TransactionRunner,
  chatBranchId: string | null,
  refs: readonly LinkRef[],
): Promise<LinkHumaniseLookup> {
  const pageIds = [...new Set(refs.flatMap((r) => (r.kind === "page" ? [r.pageId] : [])))];
  const mediaIds = [...new Set(refs.flatMap((r) => (r.kind === "media" ? [r.mediaId] : [])))];
  const slugs = new Map<string, string>();
  if (mediaIds.length > 0) {
    const media = (await tx.execute(sql`
      SELECT id::text AS id, slug FROM media_assets
       WHERE deleted_at IS NULL AND id = ANY(${uuidArray(mediaIds)})
    `)) as unknown as { id: string; slug: string }[];
    for (const m of media) slugs.set(m.id, m.slug);
  }
  const paths = new Map<string, string>();
  if (pageIds.length > 0) {
    if (chatBranchId && (await chainHasPendingMove(tx, chatBranchId, pageIds))) {
      // A pending rename or move above a named page changes its path:
      // compose it the one way every branch view does.
      const targets = await loadLinkTargets(tx, chatBranchId);
      const wanted = new Set(pageIds);
      for (const p of targets.pages) if (wanted.has(p.id)) paths.set(p.id, p.path);
    } else {
      const visible = chatBranchId
        ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${chatBranchId}::uuid)`
        : sql`p.chat_branch_id IS NULL`;
      const rows = (await tx.execute(sql`
        SELECT p.id::text AS id, p.current_path FROM pages p
         WHERE p.id = ANY(${uuidArray(pageIds)}) AND p.deleted_at IS NULL AND ${visible}
      `)) as unknown as { id: string; current_path: string }[];
      const deleted = new Set<string>();
      if (chatBranchId) {
        const heads = (await tx.execute(
          headOverlaySql({
            kind: "page",
            table: "page_snapshots",
            branchId: chatBranchId,
            ids: pageIds,
            columns: sql`(es.state->>'deletedAt') IS NOT NULL AS deleted`,
          }),
        )) as unknown as { entity_id: string; deleted: boolean }[];
        for (const h of heads) if (h.deleted) deleted.add(h.entity_id);
      }
      for (const r of rows) if (!deleted.has(r.id)) paths.set(r.id, r.current_path);
    }
  }
  return {
    pagePath: (id) => paths.get(id) ?? null,
    mediaSlug: (id) => slugs.get(id) ?? null,
  };
}

/**
 * Whether a pending page change on `branchId` gives one of `pageIds`, or
 * a page above one of them, another slug or parent than its live row —
 * the case in which a stored `current_path` is not the branch path. Reads
 * the ancestor chains (at most MAX_PAGE_DEPTH each) and the head rows of
 * exactly those pages; the head carries slug and parent, so no pending
 * state is opened.
 */
async function chainHasPendingMove(
  tx: TransactionRunner,
  branchId: string,
  pageIds: readonly string[],
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE chain(id) AS (
      SELECT unnest(${uuidArray(pageIds)})
      UNION
      SELECT p.parent_page_id FROM pages p JOIN chain c ON p.id = c.id
       WHERE p.parent_page_id IS NOT NULL
    )
    SELECT EXISTS (
      SELECT 1
        FROM (${headOverlaySql({
          kind: "page",
          table: "page_snapshots",
          branchId,
          columns: sql`d.slug AS head_slug, d.parent_page_id AS head_parent`,
          where: sql`d.entity_id IN (SELECT id FROM chain)`,
        })}) h
        JOIN pages p ON p.id = h.entity_id::uuid
       WHERE h.head_slug IS DISTINCT FROM p.slug
          OR h.head_parent IS DISTINCT FROM p.parent_page_id
    ) AS moved
  `)) as unknown as { moved: boolean }[];
  return rows[0]?.moved === true;
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
