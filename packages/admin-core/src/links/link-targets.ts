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
 * All three must agree on which page `/about` is, so all three read it
 * from here. Branch view: under a chat branch the chat sees main plus its
 * own created pages, with its pending page edits (rename, move, status,
 * delete) overlaid — the same view `pages.list` gives the chat, so a
 * link the chat writes to a page it just renamed resolves to that page.
 */

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
import { pendingSnapshotSql } from "../draft.js";
import { composePaths } from "../ops/content/compose-paths.js";
import { loadPageTree, pendingDriftIds } from "../ops/content/page-tree.js";

/** A page as link canonicalisation and humanising need it. */
export interface LinkTargetPage extends LinkIndexPage {
  readonly title: string;
}

/** Everything a scope can link to. */
export interface LinkTargets {
  readonly pages: readonly LinkTargetPage[];
  readonly media: readonly LinkIndexMedia[];
}

interface PageRow {
  id: string;
  current_path: string;
  title: string;
  status: "draft" | "published";
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
  const visibility = chatBranchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, current_path, title, status
    FROM pages
    WHERE deleted_at IS NULL AND ${visibility}
  `)) as unknown as PageRow[];
  const pages = new Map<string, LinkTargetPage>(
    rows.map((r) => [r.id, { id: r.id, path: r.current_path, title: r.title, status: r.status }]),
  );

  if (chatBranchId) {
    // Pending page edits of this chat: title / status / delete apply to
    // the row directly; a rename or move changes the path of the page
    // and everything below it, recomposed from the branch's tree.
    const overlay = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
        FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
       ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const o of overlay) {
      const base = pages.get(o.page_id);
      if (!base) continue;
      const s = (typeof o.state === "string" ? JSON.parse(o.state) : o.state) as {
        title?: string;
        status?: "draft" | "published";
        deletedAt?: string | null;
      };
      if (s.deletedAt) {
        pages.delete(o.page_id);
        continue;
      }
      pages.set(o.page_id, {
        ...base,
        title: s.title ?? base.title,
        status: s.status ?? base.status,
      });
    }
    if (overlay.length > 0) {
      const tree = await loadPageTree(tx, chatBranchId);
      const drifted = await pendingDriftIds(tx, tree, chatBranchId);
      if (drifted.length > 0) {
        const paths = await composePaths(tx, tree, drifted, { chatBranchId });
        for (const [id, path] of paths) {
          const p = pages.get(id);
          if (p) pages.set(id, { ...p, path });
        }
      }
    }
  }

  const media = (await tx.execute(sql`
    SELECT id::text AS id, slug FROM media_assets WHERE deleted_at IS NULL
  `)) as unknown as LinkIndexMedia[];
  return { pages: [...pages.values()], media };
}

/** Build the render-time link index for a preview or a build. */
export function siteLinkIndexFrom(
  targets: LinkTargets,
  env: LinkRenderEnv,
  pageUrlStyle: PageUrlStyle,
): SiteLinkIndex {
  return createSiteLinkIndex({ pages: targets.pages, media: targets.media, env, pageUrlStyle });
}
