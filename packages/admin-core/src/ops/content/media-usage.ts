// SPDX-License-Identifier: MPL-2.0

/**
 * P7 usage-tracker: `media_assets.usage_count` follows the media
 * references in module HTML.
 *
 * Invariant: a module row's HTML is counted exactly while the row is not
 * soft-deleted (`modules.deleted_at IS NULL`). Live writes (create, main
 * update, main delete) apply their delta immediately; branched writes
 * leave the live row alone and the chat merge applies the delta between
 * the live row and the merged state (`mergeBranchSnapshotsToMain`).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { extractMediaRefs } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/**
 * Resolve every media reference in an HTML string to a set of asset ids.
 * `extractMediaRefs` yields slug refs (current embeds) and legacy UUID id
 * refs; the slug refs are batch-resolved to ids in one query so the
 * usage-count diff below operates purely on ids.
 */
async function resolveHtmlToAssetIds(tx: TransactionRunner, html: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const ref of extractMediaRefs(html)) {
    if (ref.isSlug) slugs.add(ref.ref);
    else ids.add(ref.ref);
  }
  if (slugs.size > 0) {
    const slugFrags = [...slugs].map((s) => sql`${s}`);
    const rows = (await tx.execute(sql`
      SELECT id::text AS id FROM media_assets
      WHERE slug IN (${sql.join(slugFrags, sql`, `)}) AND deleted_at IS NULL
    `)) as unknown as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

/**
 * Diff media references between two HTML strings and apply usage-count
 * deltas. Called from module create / update / delete and the chat merge
 * so AI-facing surfaces (find_media's `most_used` sort, the media delete
 * guard) see what modules actually embed.
 */
export async function applyMediaUsageDelta(
  tx: TransactionRunner,
  prevHtml: string,
  nextHtml: string,
): Promise<void> {
  const prev = await resolveHtmlToAssetIds(tx, prevHtml);
  const next = await resolveHtmlToAssetIds(tx, nextHtml);
  const deltas = new Map<string, number>();
  for (const id of next) if (!prev.has(id)) deltas.set(id, (deltas.get(id) ?? 0) + 1);
  for (const id of prev) if (!next.has(id)) deltas.set(id, (deltas.get(id) ?? 0) - 1);
  if (deltas.size === 0) return;
  for (const [assetId, delta] of deltas) {
    await tx.execute(sql`
      UPDATE media_assets
      SET usage_count = GREATEST(0, usage_count + ${delta}),
          last_used_at = CASE WHEN ${delta} > 0 THEN now() ELSE last_used_at END
      WHERE id = ${assetId}::uuid AND deleted_at IS NULL
    `);
  }
}
