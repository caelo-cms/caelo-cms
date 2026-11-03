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
 * #1287 — the live rows are found through `content_instance_refs`
 * (migration 0458), derived state the database maintains on every
 * content-instance write, never by scanning every instance's values as
 * text: that scan grew with all content on the site and passed the 60 s
 * statement timeout on a large one.
 *
 * Branch view: live rows visible to the caller (main + rows this branch
 * created), with the branch's latest PENDING content-instance snapshot
 * (the same boundary `loadBranchedModuleStates` uses) superseding the
 * live values. A content instance the branch deleted does not count.
 */

import {
  defineOperation,
  type TransactionRunner,
  textArray,
  uuidArray,
} from "@caelo-cms/query-api";
import { extractMediaRefs, ok } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { headOverlaySql, pendingCandidatesSql, pendingRefCandidatesSql } from "../../draft.js";
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
 * What a caller looks for in content-instance values — the kinds of
 * `content_instance_refs` (migration 0458), each answered by its index:
 *
 * - `id`: a UUID anywhere in the values — a nested instance or module id,
 *   a list id (`caelo:list/<id>`), a media id (`caelo:media/<id>`, the
 *   legacy `/_caelo/media/<id>/<variant>`).
 * - `media_slug`: a `/_caelo/media/<slug>` URL, the slug matched whole.
 */
export type ContentInstanceNeedle =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "media_slug"; readonly slug: string };

/** `ids` as `id` needles. */
export function idNeedles(ids: Iterable<string>): ContentInstanceNeedle[] {
  return [...new Set(ids)].map((id) => ({ kind: "id", id }));
}

/**
 * Whether `valuesText` holds `needle`, with the extraction rules of the
 * index — for the branch's pending states, which the index does not hold.
 */
function holdsNeedle(needle: ContentInstanceNeedle, valuesText: string): boolean {
  switch (needle.kind) {
    case "id":
      return valuesText.toLowerCase().includes(needle.id.toLowerCase());
    case "media_slug":
      return extractMediaRefs(valuesText).some((r) => r.ref === needle.slug);
  }
}

/**
 * Content instances whose values contain at least one of `needles`. The
 * match is a superset (an id needle matches the id wherever it appears);
 * callers confirm with an exact parse of `valuesText`.
 */
export async function findContentInstancesContaining(
  tx: TransactionRunner,
  chatBranchId: string | null | undefined,
  needles: readonly ContentInstanceNeedle[],
): Promise<ContentInstanceRef[]> {
  if (needles.length === 0) return [];
  return loadInstancesInView(
    tx,
    chatBranchId ?? null,
    needleFilterSql(needles),
    (branchId) => pendingNeedleCandidatesSql(branchId, needles),
    (_moduleId, valuesText) => needles.some((n) => holdsNeedle(n, valuesText)),
  );
}

/**
 * The live-row filter of `needles` (non-empty): instances whose indexed
 * references hold one of them. Exported for the plan test, which checks
 * that this exact query is served by the index.
 */
export function needleFilterSql(needles: readonly ContentInstanceNeedle[]): SQL {
  const ids = needles.flatMap((n) => (n.kind === "id" ? [n.id.toLowerCase()] : []));
  const slugs = needles.flatMap((n) => (n.kind === "media_slug" ? [n.slug] : []));
  const terms: SQL[] = [];
  if (ids.length > 0) terms.push(sql`(r.ref_kind = 'id' AND r.ref = ANY(${textArray(ids)}))`);
  if (slugs.length > 0) {
    terms.push(sql`(r.ref_kind = 'media_slug' AND r.ref = ANY(${textArray(slugs)}))`);
  }
  return sql`ci.id IN (SELECT r.content_instance_id FROM content_instance_refs r
                        WHERE ${sql.join(terms, sql` OR `)})`;
}

/** The live rows the caller sees that match `liveFilter` (see {@link loadInstancesInView}). */
export function liveInstancesSql(branchId: string | null, liveFilter: SQL): SQL {
  const visible = branchId
    ? sql`(ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${branchId}::uuid)`
    : sql`ci.chat_branch_id IS NULL`;
  return sql`
    SELECT ci.id::text AS id, ci.module_id::text AS module_id, ci."values"::text AS values_text
      FROM content_instances ci
     WHERE ci.deleted_at IS NULL AND ${visible} AND (${liveFilter})`;
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
    sql`ci.module_id = ANY(${uuidArray(moduleIds)})`,
    (branchId) =>
      pendingCandidatesSql({
        kind: "contentInstance",
        table: "content_instance_snapshots",
        branchId,
        match: sql`(es.state ->> 'moduleId') = ANY(${textArray(moduleIds)})`,
      }),
    (moduleId) => wanted.has(moduleId),
  );
}

/**
 * The pending-state candidates of `needles` (non-empty) on `branchId`:
 * head rows whose values reference one of them, from the snapshot
 * reference table of migration 0533 — the same extraction as
 * `content_instance_refs`. Exported for the plan test.
 */
export function pendingNeedleCandidatesSql(
  branchId: string,
  needles: readonly ContentInstanceNeedle[],
): SQL {
  return pendingRefCandidatesSql({
    kind: "contentInstance",
    branchId,
    ids: needles.flatMap((n) => (n.kind === "id" ? [n.id] : [])),
    mediaSlugs: needles.flatMap((n) => (n.kind === "media_slug" ? [n.slug] : [])),
  });
}

/**
 * The live rows matching `liveFilter`, with the branch's pending states
 * superseding them (kept when `matchesBranched` accepts the branched
 * values) and instances the branch deleted dropped.
 *
 * Every read is served by an index, so the cost is the matches, never the
 * site or the draft (#1391). The pending side used to filter every pending
 * state of the branch in memory or by `strpos`, once per needle: on the
 * shared draft that is every instance any chat changed since the last
 * Stage, and on searchVIU production (2026-11-03) a plugin's change
 * consumer paid it after every agent write until the db-f1-micro was
 * saturated. Now:
 *   1. the live matches (`liveFilter`, an indexed predicate on `ci`);
 *   2. the pending candidates (`pendingCandidates`, an indexed lookup of
 *      head rows of the branch: `pendingRefCandidatesSql` /
 *      `pendingCandidatesSql`);
 *   3. the newest pending state of exactly those instances
 *      (`headOverlaySql`), which supersedes the live row: it is kept when
 *      `matchesBranched` accepts it, and a deleted one drops the instance.
 */
async function loadInstancesInView(
  tx: TransactionRunner,
  branchId: string | null,
  liveFilter: SQL,
  pendingCandidates: (branchId: string) => SQL,
  matchesBranched: (moduleId: string, valuesText: string) => boolean,
): Promise<ContentInstanceRef[]> {
  const liveRows = (await tx.execute(liveInstancesSql(branchId, liveFilter))) as unknown as {
    id: string;
    module_id: string;
    values_text: string;
  }[];
  const out = new Map<string, ContentInstanceRef>();
  for (const r of liveRows) {
    out.set(r.id, { contentInstanceId: r.id, moduleId: r.module_id, valuesText: r.values_text });
  }
  if (!branchId) return [...out.values()];

  const candidates = (await tx.execute(pendingCandidates(branchId))) as unknown as {
    entity_id: string;
  }[];
  const ids = [...new Set([...out.keys(), ...candidates.map((c) => c.entity_id)])];
  if (ids.length === 0) return [];
  const heads = (await tx.execute(
    headOverlaySql({ kind: "contentInstance", table: "content_instance_snapshots", branchId, ids }),
  )) as unknown as { entity_id: string; state: unknown }[];
  for (const h of heads) {
    // The branch's own state decides for this caller, match or not.
    out.delete(h.entity_id);
    const state = h.state as ContentInstanceState;
    if (state.deletedAt) continue;
    const valuesText = JSON.stringify(state.values ?? {});
    if (matchesBranched(state.moduleId, valuesText)) {
      out.set(h.entity_id, {
        contentInstanceId: h.entity_id,
        moduleId: state.moduleId,
        valuesText,
      });
    }
  }
  return [...out.values()];
}

/**
 * How far `content_instance_refs` is from what the values say now: rows
 * the extraction would add (`missing`) and rows it would not produce
 * (`extra`). Both are 0 while the triggers of migration 0458 hold.
 */
export async function contentInstanceRefsDrift(
  tx: TransactionRunner,
): Promise<{ missing: number; extra: number }> {
  const rows = (await tx.execute(sql`
    WITH expected AS (
      SELECT ci.id AS content_instance_id, r.ref_kind, r.ref
        FROM content_instances ci
       CROSS JOIN LATERAL caelo_content_instance_ref_rows(ci."values") r
    )
    SELECT
      (SELECT count(*)::int FROM (SELECT * FROM expected
                                  EXCEPT SELECT content_instance_id, ref_kind, ref
                                           FROM content_instance_refs) d) AS missing,
      (SELECT count(*)::int FROM (SELECT content_instance_id, ref_kind, ref FROM content_instance_refs
                                  EXCEPT SELECT * FROM expected) d) AS extra
  `)) as unknown as { missing: number; extra: number }[];
  return { missing: rows[0]?.missing ?? 0, extra: rows[0]?.extra ?? 0 };
}

/** The expected rows of the snapshot reference tables (migration 0533). */
const SNAPSHOT_REFS_EXPECTED = `
  SELECT 'ci' AS t, s.id AS snapshot_row_id, r.ref_kind, r.ref
    FROM content_instance_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'values') r
  UNION ALL
  SELECT 'pl', s.id, r.ref_kind, r.ref
    FROM page_layout_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state) r`;

/** The maintained rows of the snapshot reference tables (migration 0533). */
const SNAPSHOT_REFS_MAINTAINED = `
  SELECT 'ci' AS t, snapshot_row_id, ref_kind, ref FROM content_instance_snapshot_refs
  UNION ALL
  SELECT 'pl', snapshot_row_id, ref_kind, ref FROM page_layout_snapshot_refs`;

/**
 * SQL of how far the snapshot reference tables (migration 0533) are from
 * what the snapshot states say now: `missing` / `extra` rows. Both are 0
 * while the triggers hold. Shared with the integration preload's check.
 */
export const SNAPSHOT_REFS_DRIFT_SQL = `
  WITH expected AS (${SNAPSHOT_REFS_EXPECTED}), maintained AS (${SNAPSHOT_REFS_MAINTAINED})
  SELECT (SELECT count(*)::int FROM (SELECT * FROM expected EXCEPT SELECT * FROM maintained) d) AS missing,
         (SELECT count(*)::int FROM (SELECT * FROM maintained EXCEPT SELECT * FROM expected) d) AS extra`;

/** {@link SNAPSHOT_REFS_DRIFT_SQL} in a transaction. */
export async function snapshotRefsDrift(
  tx: TransactionRunner,
): Promise<{ missing: number; extra: number }> {
  const rows = (await tx.execute(sql.raw(SNAPSHOT_REFS_DRIFT_SQL))) as unknown as {
    missing: number;
    extra: number;
  }[];
  return { missing: rows[0]?.missing ?? 0, extra: rows[0]?.extra ?? 0 };
}

export const rebuildContentInstanceRefsOp = defineOperation({
  name: "content_instances.rebuild_refs",
  // Why human-only: system-only. Derived state the database maintains
  // itself; the rebuild is the repair path of rule 3
  // (docs/dev/state-and-changes.md), never part of editing.
  actorScope: ["system"],
  // Why site-wide: a rebuild re-derives the references of every instance.
  readScope: "site",
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** Rows the table holds after the rebuild. */
    rows: z.number().int().nonnegative(),
    /** Drift found before the rebuild (0/0 = the triggers were exact). */
    drift: z.object({
      missing: z.number().int().nonnegative(),
      extra: z.number().int().nonnegative(),
    }),
    /** #1391 — rows the snapshot reference tables (0533) hold after. */
    snapshotRows: z.number().int().nonnegative(),
    /** #1391 — their drift found before the rebuild. */
    snapshotDrift: z.object({
      missing: z.number().int().nonnegative(),
      extra: z.number().int().nonnegative(),
    }),
  }),
  handler: async (_ctx, _input, tx) => {
    const drift = await contentInstanceRefsDrift(tx);
    const snapshotDrift = await snapshotRefsDrift(tx);
    const rows = (await tx.execute(
      sql`SELECT caelo_content_instance_refs_rebuild()::int AS n,
                 caelo_snapshot_refs_rebuild()::int AS s`,
    )) as unknown as { n: number; s: number }[];
    return ok({ rows: rows[0]?.n ?? 0, drift, snapshotRows: rows[0]?.s ?? 0, snapshotDrift });
  },
});
