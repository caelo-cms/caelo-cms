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
import { headOverlaySql } from "../../draft.js";
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
    branchedNeedleSql(needles),
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
    sql`es.state->>'moduleId' = ANY(${textArray(moduleIds)})`,
    (moduleId) => wanted.has(moduleId),
  );
}

/**
 * The branch-state prefilter of `needles` (non-empty): a pending state
 * whose values text holds one of them. A superset of {@link holdsNeedle},
 * which confirms; `es` is the snapshot row of {@link headOverlaySql}.
 */
function branchedNeedleSql(needles: readonly ContentInstanceNeedle[]): SQL {
  const ids = needles.flatMap((n) => (n.kind === "id" ? [n.id.toLowerCase()] : []));
  const slugs = needles.flatMap((n) => (n.kind === "media_slug" ? [n.slug] : []));
  const values = sql`(es.state->'values')::text`;
  const terms: SQL[] = [];
  if (ids.length > 0) {
    terms.push(
      sql`EXISTS (SELECT 1 FROM unnest(${textArray(ids)}) n WHERE strpos(lower(${values}), n) > 0)`,
    );
  }
  if (slugs.length > 0) {
    terms.push(
      sql`EXISTS (SELECT 1 FROM unnest(${textArray(slugs)}) n WHERE strpos(${values}, n) > 0)`,
    );
  }
  return sql`(${sql.join(terms, sql` OR `)})`;
}

/**
 * The live rows matching `liveFilter`, with the branch's pending states
 * superseding them (kept when `matchesBranched` accepts the branched
 * values) and instances the branch deleted dropped.
 *
 * The pending states come from the draft head (one row per pending
 * instance, `headOverlaySql`), never from the branch's whole pending
 * history: on the shared draft that history grows with every write of
 * every chat until the next Stage, and sorting all of it — states
 * included — for one lookup passed the 60 s statement timeout on
 * production (2026-11-03, a plugin's change consumer calling
 * `content_instances.list({ ids })` after each agent write). Only the
 * states `branchedFilter` (a superset of `matchesBranched`, over `es`)
 * keeps are read out; the rest only supersede their live row.
 */
async function loadInstancesInView(
  tx: TransactionRunner,
  branchId: string | null,
  liveFilter: SQL,
  branchedFilter: SQL,
  matchesBranched: (moduleId: string, valuesText: string) => boolean,
): Promise<ContentInstanceRef[]> {
  const out = new Map<string, ContentInstanceRef>();

  // Branched states first: they supersede the live row for this caller.
  const branched = new Set<string>();
  if (branchId) {
    const rows = (await tx.execute(
      headOverlaySql({
        kind: "contentInstance",
        table: "content_instance_snapshots",
        branchId,
        columns: sql`CASE WHEN ${branchedFilter} THEN es.state END AS state`,
      }),
    )) as unknown as { entity_id: string; state: unknown }[];
    for (const r of rows) {
      branched.add(r.entity_id);
      if (r.state === null) continue; // superseded, and cannot match
      const state = r.state as ContentInstanceState;
      if (state.deletedAt) continue;
      const valuesText = JSON.stringify(state.values ?? {});
      if (matchesBranched(state.moduleId, valuesText)) {
        out.set(r.entity_id, {
          contentInstanceId: r.entity_id,
          moduleId: state.moduleId,
          valuesText,
        });
      }
    }
  }

  const liveRows = (await tx.execute(liveInstancesSql(branchId, liveFilter))) as unknown as {
    id: string;
    module_id: string;
    values_text: string;
  }[];
  for (const r of liveRows) {
    if (branched.has(r.id)) continue; // the branch's own state decided above
    out.set(r.id, { contentInstanceId: r.id, moduleId: r.module_id, valuesText: r.values_text });
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
  }),
  handler: async (_ctx, _input, tx) => {
    const drift = await contentInstanceRefsDrift(tx);
    const rows = (await tx.execute(
      sql`SELECT caelo_content_instance_refs_rebuild()::int AS n`,
    )) as unknown as { n: number }[];
    return ok({ rows: rows[0]?.n ?? 0, drift });
  },
});
