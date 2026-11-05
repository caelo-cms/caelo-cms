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
 *
 * #1375 — that latest pending state comes from the draft head
 * (`draft_pending_entities`, #1268): one row per pending instance. The
 * earlier read walked every pending content-instance snapshot of the
 * branch, with its full state, and sorted them; on the shared draft of a
 * site with several agents at work that is the whole day's edit history,
 * and it ran on every `content_instances.get` / `.list` / `set_values_many`
 * and `lists.list` (through the reach). Each took the 60 s statement
 * timeout on the production database, held a pooled connection for it,
 * and the admin answered nothing for half an hour.
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
import { headOverlaySql, pendingRefCandidatesSql } from "../../draft.js";
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
 *
 * @param liveLimitPerModuleNeedle for `id` needles that are module ids: read
 *   at most this many live matches per module, for a caller that names
 *   parents rather than listing every instance (a module nested in
 *   thousands). Only matches that can survive count towards it.
 */
export async function findContentInstancesContaining(
  tx: TransactionRunner,
  chatBranchId: string | null | undefined,
  needles: readonly ContentInstanceNeedle[],
  liveLimitPerModuleNeedle?: number,
): Promise<ContentInstanceRef[]> {
  if (needles.length === 0) return [];
  const branchId = chatBranchId ?? null;
  return loadInstancesInView(
    tx,
    branchId,
    liveLimitPerModuleNeedle === undefined
      ? needleFilterSql(needles)
      : boundedModuleNeedleFilterSql(needles, branchId, liveLimitPerModuleNeedle),
    { candidates: (branchId) => pendingNeedleCandidatesSql(branchId, needles) },
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

/** Rows of `ci` the caller's branch can see. */
function visibleInstanceSql(branchId: string | null): SQL {
  return branchId
    ? sql`(ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${branchId}::uuid)`
    : sql`ci.chat_branch_id IS NULL`;
}

/**
 * {@link needleFilterSql} for module-id needles that stops after `limit`
 * instances per module. Everything that would drop an instance later sits
 * inside the limit, or a sample of dropped rows would report a nested module
 * as unplaced while a surviving parent exists: visibility, the parent being
 * another module that is not deleted, live or on this branch, and no pending
 * state of the instance (those are read through the pending candidates).
 */
function boundedModuleNeedleFilterSql(
  needles: readonly ContentInstanceNeedle[],
  branchId: string | null,
  limit: number,
): SQL {
  const ids = needles.flatMap((n) => (n.kind === "id" ? [n.id.toLowerCase()] : []));
  const notPending = branchId
    ? sql`AND (SELECT true FROM draft_pending_entities h
                WHERE h.chat_branch_id = ${branchId}::uuid
                  AND h.entity_kind = 'contentInstance' AND h.entity_id = ci.id
                LIMIT 1) IS NULL
          AND NOT COALESCE((
            SELECT (ms.state->>'deletedAt') IS NOT NULL
              FROM draft_pending_entities h
              JOIN module_snapshots ms ON ms.id = h.snapshot_row_id
             WHERE h.chat_branch_id = ${branchId}::uuid
               AND h.entity_kind = 'module' AND h.entity_id = ci.module_id
             ORDER BY h.header_created_at DESC, h.row_created_at DESC, h.snapshot_row_id DESC
             LIMIT 1), false)`
    : sql``;
  return sql`ci.id IN (
    SELECT hit.id
      FROM unnest(${textArray(ids)}) AS needle(ref)
     CROSS JOIN LATERAL (
       SELECT ci.id
         FROM content_instance_refs r
         JOIN content_instances ci ON ci.id = r.content_instance_id
         JOIN modules parent ON parent.id = ci.module_id AND parent.deleted_at IS NULL
        WHERE r.ref_kind = 'id' AND r.ref = needle.ref AND ci.module_id::text <> needle.ref
          AND ci.deleted_at IS NULL AND ${visibleInstanceSql(branchId)} ${notPending}
        LIMIT ${limit}
     ) hit)`;
}

/** The live rows the caller sees that match `liveFilter` (see {@link loadInstancesInView}). */
export function liveInstancesSql(branchId: string | null, liveFilter: SQL): SQL {
  const visible = visibleInstanceSql(branchId);
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
    // An instance never changes its module, so filtering the head rows by
    // module drops whole instances, never an owner's newer state: one head
    // read, one snapshot row per pending instance of these modules.
    { headWhere: sql`(es.state ->> 'moduleId') = ANY(${textArray(moduleIds)})` },
    (moduleId) => wanted.has(moduleId),
  );
}

/**
 * The pending-state candidates of `needles` (non-empty) on `branchId`:
 * head rows whose values reference one of them, from the snapshot
 * reference table of migration 0592 — the same extraction as
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
 *   2. the newest pending state of the instances that may match, which
 *      supersedes the live row (kept when `matchesBranched` accepts it; a
 *      deleted one drops the instance): either the candidates an index
 *      names (`pendingRefCandidatesSql`) plus the live matches, read by id,
 *      or — for a filter that holds for an instance's every state, like
 *      its module — the head rows filtered in one read (`headWhere`).
 */
async function loadInstancesInView(
  tx: TransactionRunner,
  branchId: string | null,
  liveFilter: SQL,
  pending: { readonly candidates: (branchId: string) => SQL } | { readonly headWhere: SQL },
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

  let heads: { entity_id: string; state: unknown }[];
  if ("headWhere" in pending) {
    heads = (await tx.execute(
      headOverlaySql({
        kind: "contentInstance",
        table: "content_instance_snapshots",
        branchId,
        where: pending.headWhere,
      }),
    )) as unknown as { entity_id: string; state: unknown }[];
  } else {
    const candidates = (await tx.execute(pending.candidates(branchId))) as unknown as {
      entity_id: string;
    }[];
    const ids = [...new Set([...out.keys(), ...candidates.map((c) => c.entity_id)])];
    if (ids.length === 0) return [];
    heads = (await tx.execute(
      headOverlaySql({
        kind: "contentInstance",
        table: "content_instance_snapshots",
        branchId,
        ids,
      }),
    )) as unknown as { entity_id: string; state: unknown }[];
  }
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

/** The expected rows of the snapshot reference tables (0592, 0594) and the list / module reference tables (0595). */
const SNAPSHOT_REFS_EXPECTED = `
  SELECT 'ci' AS t, s.id AS snapshot_row_id, r.ref_kind, r.ref
    FROM content_instance_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'values') r
  UNION ALL
  SELECT 'pl', s.id, r.ref_kind, r.ref
    FROM page_layout_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state) r
  UNION ALL
  SELECT 'p', s.id, r.ref_kind, r.ref
    FROM page_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'terms') r
  UNION ALL
  SELECT 'l', s.id, r.ref_kind, r.ref
    FROM lists s CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.items) r
  UNION ALL
  SELECT 'm', s.id, r.ref_kind, r.ref
    FROM modules s CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.fields) r
  UNION ALL
  SELECT 'ls', s.id, r.ref_kind, r.ref
    FROM list_snapshots s CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'items') r
  UNION ALL
  SELECT 'ms', s.id, r.ref_kind, r.ref
    FROM module_snapshots s CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'fields') r`;

/** The maintained rows of the tables of {@link SNAPSHOT_REFS_EXPECTED}. */
const SNAPSHOT_REFS_MAINTAINED = `
  SELECT 'ci' AS t, snapshot_row_id, ref_kind, ref FROM content_instance_snapshot_refs
  UNION ALL
  SELECT 'pl', snapshot_row_id, ref_kind, ref FROM page_layout_snapshot_refs
  UNION ALL
  SELECT 'p', snapshot_row_id, ref_kind, ref FROM page_snapshot_refs
  UNION ALL
  SELECT 'l', list_id, ref_kind, ref FROM list_refs
  UNION ALL
  SELECT 'm', module_id, ref_kind, ref FROM module_refs
  UNION ALL
  SELECT 'ls', snapshot_row_id, ref_kind, ref FROM list_snapshot_refs
  UNION ALL
  SELECT 'ms', snapshot_row_id, ref_kind, ref FROM module_snapshot_refs`;

/**
 * SQL of how far the snapshot reference tables (migration 0592) are from
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
    /** #1391 — rows the snapshot (0592, 0594) and list / module (0595) reference tables hold after. */
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
                 caelo_snapshot_refs_rebuild()::int AS s,
                 caelo_list_module_refs_rebuild()::int AS lm`,
    )) as unknown as { n: number; s: number; lm: number }[];
    return ok({
      rows: rows[0]?.n ?? 0,
      drift,
      snapshotRows: (rows[0]?.s ?? 0) + (rows[0]?.lm ?? 0),
      snapshotDrift,
    });
  },
});
