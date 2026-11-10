// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1062 — `content_instances.list_module_peers`: the content
 * instances of the module(s) a write touched that hold one of the written
 * field values, and nothing else.
 *
 * The repeated-value hint after a content write counts the other
 * instances of the SAME module that now carry a written value. This op
 * resolves the write's targets (module ids, instance ids, placements) to
 * their modules and reads, as the caller's branch sees them:
 *
 * - the instances of those modules holding one of the written field
 *   values, by its hash (`content_value_hashes`, migration 0658: equality
 *   on text is leakproof, so the lookup stays on its index under RLS);
 * - on a branch, the instances whose pending state there holds one
 *   (`draft_pending_content_value_hashes`); each candidate's newest state
 *   decides (a pending edit can add a copy the live row lacks, or remove
 *   one it has), confirmed on its values.
 *
 * #1269 — it used to read every instance of the modules: a page module
 * with one instance per page is the whole site, so on the 50k-page scale
 * gate each AI content write read 50,000 instances and counted their
 * placements. Now the cost is the instances and pending states holding a
 * written value, never the module or the draft. Values shorter than 20
 * characters are not hashed: the hint never asks about them.
 */

import { defineOperation, type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { stableJson } from "../../links/migrate-convert.js";
import {
  loadContentInstanceBranchStates,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { countPlacementsAtMost } from "./content-instance-reach.js";

const MAX_TARGETS = 200;
/** Field values one call matches (a write's distinct values worth a hint). */
const MAX_MATCHES = 200;

/** Input of `content_instances.list_module_peers`. */
export const listModulePeersInput = z
  .object({
    moduleIds: z.array(z.string().uuid()).max(MAX_TARGETS).default([]),
    contentInstanceIds: z.array(z.string().uuid()).max(MAX_TARGETS).default([]),
    placements: z
      .array(
        z
          .object({
            pageId: z.string().uuid(),
            blockName: z.string().min(1).max(80),
            position: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(MAX_TARGETS)
      .default([]),
    /** The written field values: an instance is returned when it holds one. */
    matches: z
      .array(z.object({ field: z.string().min(1).max(200), value: z.unknown() }).strict())
      .min(1)
      .max(MAX_MATCHES),
  })
  .strict();

const peerSchema = z.object({
  id: z.string(),
  moduleId: z.string(),
  moduleDisplayName: z.string(),
  /** Capped at 2: the hint only tells private (0–1) from shared (2+). */
  placementCount: z.number().int().nonnegative(),
  values: z.record(z.string(), z.unknown()),
});

interface PeerRow {
  readonly id: string;
  readonly module_id: string;
  readonly module_display_name: string;
  readonly values: unknown;
}

export const listModulePeersOp = defineOperation({
  name: "content_instances.list_module_peers",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: listModulePeersInput,
  output: z.object({ instances: z.array(peerSchema) }),
  handler: async (ctx, input, tx) => {
    const branchId = ctx.chatBranchId ?? null;
    const visible = branchId
      ? sql`(ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${branchId}::uuid)`
      : sql`ci.chat_branch_id IS NULL`;
    const moduleIds = new Set(input.moduleIds);
    if (input.contentInstanceIds.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT ci.module_id::text AS module_id FROM content_instances ci
        WHERE ci.id = ANY(${uuidArray(input.contentInstanceIds)}) AND ${visible}
      `)) as unknown as { module_id: string }[];
      for (const r of rows) moduleIds.add(r.module_id);
    }
    for (const pageId of new Set(input.placements.map((p) => p.pageId))) {
      const layout = await loadPageLayoutStateWithBranchOverlay(tx, pageId, branchId);
      for (const p of input.placements.filter((x) => x.pageId === pageId)) {
        const placed = layout.blocks.find((b) => b.blockName === p.blockName)?.placements?.[
          p.position
        ];
        if (placed) moduleIds.add(placed.moduleId);
      }
    }
    if (moduleIds.size === 0) return ok({ instances: [] });

    const modules = uuidArray([...moduleIds]);
    // The written values as 0658 hashes them: md5 of the jsonb text.
    const hashed = (alias: string) =>
      sql.join(
        input.matches.map(
          (m) =>
            sql`(${sql.raw(alias)}.field = ${m.field} AND ${sql.raw(alias)}.hash = md5(caelo_content_value_norm((${JSON.stringify(m.value)}::text)::jsonb)::text))`,
        ),
        sql` OR `,
      );
    const matched = (await tx.execute(sql`
      SELECT ci.id::text AS id, ci.module_id::text AS module_id,
             m.display_name AS module_display_name, ci."values" AS values
      FROM (SELECT DISTINCT h.instance_id FROM content_value_hashes h
             WHERE h.module_id = ANY(${modules}) AND (${hashed("h")})) h
      JOIN content_instances ci ON ci.id = h.instance_id
      JOIN modules m ON m.id = ci.module_id
      WHERE ci.deleted_at IS NULL AND ${visible}
    `)) as unknown as PeerRow[];
    // On a branch a pending state decides: it may hold a written value the
    // live row lacks. The branch's pending states holding one (0658's draft
    // table); a live match whose pending state dropped the value is
    // filtered below on its newest state.
    const pending = branchId
      ? ((await tx.execute(sql`
          SELECT ci.id::text AS id, ci.module_id::text AS module_id,
                 m.display_name AS module_display_name, ci."values" AS values
          FROM (SELECT DISTINCT w.instance_id FROM draft_pending_content_value_hashes w
                 WHERE w.chat_branch_id = ${branchId}::uuid AND (${hashed("w")})) w
          JOIN content_instances ci ON ci.id = w.instance_id
          JOIN modules m ON m.id = ci.module_id
          WHERE ci.module_id = ANY(${modules}) AND ci.deleted_at IS NULL AND ${visible}
        `)) as unknown as PeerRow[])
      : [];
    const byId = new Map<string, PeerRow>();
    for (const r of [...matched, ...pending]) byId.set(r.id, r);
    const rows = [...byId.values()];
    const ids = rows.map((r) => r.id);
    const states = branchId
      ? await loadContentInstanceBranchStates(tx, ids, branchId)
      : new Map<string, never>();
    // Compared as the guard compares: strings trimmed (caelo_content_value_norm).
    const norm = (v: unknown): string => stableJson(typeof v === "string" ? v.trim() : v);
    const holds = (values: Record<string, unknown>): boolean =>
      input.matches.some((m) => m.field in values && norm(values[m.field]) === norm(m.value));
    const valuesOf = (r: PeerRow): Record<string, unknown> =>
      states.get(r.id)?.values ?? ((r.values ?? {}) as Record<string, unknown>);
    const live = rows.filter((r) => !states.get(r.id)?.deletedAt && holds(valuesOf(r)));
    // The hint tells private from shared: two placements decide, so a
    // shared match on many pages costs two rows, not its placements.
    const counts = await countPlacementsAtMost(
      tx,
      live.map((r) => r.id),
      branchId,
      2,
    );
    return ok({
      instances: live.map((r) => {
        return {
          id: r.id,
          moduleId: r.module_id,
          moduleDisplayName: r.module_display_name,
          placementCount: counts.get(r.id) ?? 0,
          values: valuesOf(r),
        };
      }),
    });
  },
});

/** Drift of the two hash tables from their source (0658): rows missing and rows extra. */
export async function contentValueHashesDrift(
  tx: TransactionRunner,
): Promise<{ missing: number; extra: number }> {
  const rows = (await tx.execute(sql`
    WITH expected AS (SELECT * FROM caelo_content_value_hashes_expected()),
         maintained AS (
           SELECT 'live'::text AS t, NULL::uuid AS chat_branch_id, NULL::uuid AS snapshot_row_id,
                  module_id, field::text AS field, hash::text AS hash, instance_id
             FROM content_value_hashes
           UNION ALL
           SELECT 'draft', chat_branch_id, snapshot_row_id, NULL::uuid, field::text, hash::text,
                  instance_id
             FROM draft_pending_content_value_hashes)
    SELECT (SELECT count(*)::int FROM (SELECT * FROM expected EXCEPT SELECT * FROM maintained) d) AS missing,
           (SELECT count(*)::int FROM (SELECT * FROM maintained EXCEPT SELECT * FROM expected) d) AS extra`)) as unknown as {
    missing: number;
    extra: number;
  }[];
  return { missing: rows[0]?.missing ?? 0, extra: rows[0]?.extra ?? 0 };
}

export const rebuildContentValueHashesOp = defineOperation({
  name: "content_instances.rebuild_value_hashes",
  // Why human-only: system-only. Derived state the database maintains
  // itself; the rebuild is the repair path of rule 3
  // (docs/dev/state-and-changes.md), never part of editing.
  actorScope: ["system"],
  // Why site-wide: a rebuild re-derives the hashes of every instance and
  // every pending instance state.
  readScope: "site",
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** Rows both hash tables hold after the rebuild. */
    rows: z.number().int().nonnegative(),
    /** Drift found before the rebuild (0/0 = the triggers were exact). */
    drift: z.object({
      missing: z.number().int().nonnegative(),
      extra: z.number().int().nonnegative(),
    }),
  }),
  handler: async (_ctx, _input, tx) => {
    const drift = await contentValueHashesDrift(tx);
    const rows = (await tx.execute(
      sql`SELECT caelo_content_value_hashes_rebuild()::int AS n`,
    )) as unknown as { n: number }[];
    return ok({ rows: rows[0]?.n ?? 0, drift });
  },
});
