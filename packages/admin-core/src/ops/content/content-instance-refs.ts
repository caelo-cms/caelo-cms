// SPDX-License-Identifier: MPL-2.0

/**
 * Which content instances reference something — as the CALLER sees them?
 *
 * Content-instance `values` can point at other entities without any
 * relational row: a `module` / `module-list` field stores
 * `{ moduleId, contentInstanceId }` (a nested module rendered recursively,
 * with no `page_modules` row of its own) and an `image` field stores a
 * `/_caelo/media/<slug>` URL (no `media_assets.usage_count` bump). The
 * in-use guards behind `modules.delete` and `media.delete_many` read this
 * helper so a nested module or a content-field image is "in use" too.
 *
 * Branch view: live rows visible to the caller (main + rows this branch
 * created), with the branch's latest content-instance snapshot written
 * after its last Stage (`chat_sessions.last_staged_at`, the same boundary
 * `loadBranchedModuleStates` uses) superseding the live values. A
 * content instance the branch deleted does not count.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ContentInstanceState } from "../../snapshots/state.js";

/** One content instance whose values matched, with its values as JSON text. */
export interface ContentInstanceRef {
  readonly contentInstanceId: string;
  /** The module this content instance fills (the "parent"). */
  readonly moduleId: string;
  /** `values` serialised as JSON text — callers run their exact match on it. */
  readonly valuesText: string;
}

/**
 * Content instances whose values contain at least one of `needles` (plain
 * substrings). The needle match is a cheap prefilter; callers confirm with
 * an exact parse of `valuesText` where a substring could over-match.
 */
export async function findContentInstancesContaining(
  tx: TransactionRunner,
  chatBranchId: string | null | undefined,
  needles: readonly string[],
): Promise<ContentInstanceRef[]> {
  if (needles.length === 0) return [];
  const branchId = chatBranchId ?? null;
  const out = new Map<string, ContentInstanceRef>();

  // Branched states first: they supersede the live row for this caller.
  const branched = new Map<string, ContentInstanceState>();
  if (branchId) {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (cis.content_instance_id)
             cis.content_instance_id::text AS id, cis.state
        FROM content_instance_snapshots cis
        JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
        LEFT JOIN chat_sessions cs ON cs.chat_branch_id = ss.chat_branch_id
       WHERE ss.chat_branch_id = ${branchId}::uuid
         AND ss.created_at > COALESCE(cs.last_staged_at, '-infinity'::timestamptz)
       ORDER BY cis.content_instance_id, ss.created_at DESC
    `)) as unknown as { id: string; state: unknown }[];
    for (const r of rows) {
      const state = (
        typeof r.state === "string" ? JSON.parse(r.state) : r.state
      ) as ContentInstanceState;
      branched.set(r.id, state);
      if (state.deletedAt) continue;
      const valuesText = JSON.stringify(state.values ?? {});
      if (needles.some((n) => valuesText.includes(n))) {
        out.set(r.id, { contentInstanceId: r.id, moduleId: state.moduleId, valuesText });
      }
    }
  }

  const visible = branchId
    ? sql`(ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${branchId}::uuid)`
    : sql`ci.chat_branch_id IS NULL`;
  const likeAny = sql.join(
    needles.map((n) => sql`ci."values"::text LIKE ${`%${n}%`}`),
    sql` OR `,
  );
  const liveRows = (await tx.execute(sql`
    SELECT ci.id::text AS id, ci.module_id::text AS module_id, ci."values"::text AS values_text
      FROM content_instances ci
     WHERE ci.deleted_at IS NULL AND ${visible} AND (${likeAny})
  `)) as unknown as { id: string; module_id: string; values_text: string }[];
  for (const r of liveRows) {
    if (branched.has(r.id)) continue; // the branch's own state decided above
    out.set(r.id, { contentInstanceId: r.id, moduleId: r.module_id, valuesText: r.values_text });
  }
  return [...out.values()];
}
