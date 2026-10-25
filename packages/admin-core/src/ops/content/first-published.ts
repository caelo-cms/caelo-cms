// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `pages.first_published_at` (docs/lists.md §5): the moment a
 * page first went live. Page queries order "latest news" by it, so it is
 * set by Publish live (a successful production build or promote) and by
 * nothing else — never by the AI, never by a Stage.
 *
 * The pages stamped are the live, published pages that existed when the
 * shipped build was rendered (`builtAt`): a page created or published after
 * that build is not in it and is stamped by the next Publish live.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** Stamp every page the shipped build contains that was never live before. */
export async function stampFirstPublished(
  tx: TransactionRunner,
  builtAtRunId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE pages p
       SET first_published_at = clock_timestamp()
      FROM deploy_runs r
     WHERE r.id = ${builtAtRunId}::uuid
       AND p.first_published_at IS NULL
       AND p.chat_branch_id IS NULL
       AND p.deleted_at IS NULL
       AND p.status = 'published'
       AND p.created_at <= r.started_at
  `);
}
