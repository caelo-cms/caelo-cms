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
 * created), with the branch's latest PENDING content-instance snapshot
 * (the same boundary `loadBranchedModuleStates` uses) superseding the
 * live values. A
 * content instance the branch deleted does not count.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";
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
  return loadInstancesInView(
    tx,
    chatBranchId ?? null,
    sql.join(
      needles.map((n) => sql`ci."values"::text LIKE ${`%${n}%`}`),
      sql` OR `,
    ),
    (_moduleId, valuesText) => needles.some((n) => valuesText.includes(n)),
  );
}

/**
 * Content instances (the caller's view) that fill any of `moduleIds` —
 * the instances a module's field default renders through when they leave
 * that field unset (#627).
 */
export async function findContentInstancesOfModules(
  tx: TransactionRunner,
  chatBranchId: string | null | undefined,
  moduleIds: readonly string[],
): Promise<ContentInstanceRef[]> {
  if (moduleIds.length === 0) return [];
  const wanted = new Set(moduleIds);
  return loadInstancesInView(
    tx,
    chatBranchId ?? null,
    sql`ci.module_id IN (${sql.join(
      moduleIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
    (moduleId) => wanted.has(moduleId),
  );
}

/**
 * The live rows matching `liveFilter`, with the branch's pending states
 * superseding them (kept when `matchesBranched` accepts the branched
 * values) and instances the branch deleted dropped.
 */
async function loadInstancesInView(
  tx: TransactionRunner,
  branchId: string | null,
  liveFilter: SQL,
  matchesBranched: (moduleId: string, valuesText: string) => boolean,
): Promise<ContentInstanceRef[]> {
  const out = new Map<string, ContentInstanceRef>();

  // Branched states first: they supersede the live row for this caller.
  const branched = new Set<string>();
  if (branchId) {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (cis.content_instance_id)
             cis.content_instance_id::text AS id, cis.state
        FROM content_instance_snapshots cis
        JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
       WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
       ORDER BY cis.content_instance_id, ss.created_at DESC
    `)) as unknown as { id: string; state: unknown }[];
    for (const r of rows) {
      const state = r.state as ContentInstanceState;
      branched.add(r.id);
      if (state.deletedAt) continue;
      const valuesText = JSON.stringify(state.values ?? {});
      if (matchesBranched(state.moduleId, valuesText)) {
        out.set(r.id, { contentInstanceId: r.id, moduleId: state.moduleId, valuesText });
      }
    }
  }

  const visible = branchId
    ? sql`(ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${branchId}::uuid)`
    : sql`ci.chat_branch_id IS NULL`;
  const liveRows = (await tx.execute(sql`
    SELECT ci.id::text AS id, ci.module_id::text AS module_id, ci."values"::text AS values_text
      FROM content_instances ci
     WHERE ci.deleted_at IS NULL AND ${visible} AND (${liveFilter})
  `)) as unknown as { id: string; module_id: string; values_text: string }[];
  for (const r of liveRows) {
    if (branched.has(r.id)) continue; // the branch's own state decided above
    out.set(r.id, { contentInstanceId: r.id, moduleId: r.module_id, valuesText: r.values_text });
  }
  return [...out.values()];
}
