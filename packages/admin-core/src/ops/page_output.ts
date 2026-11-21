// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R1, issue #1647) — the bookkeeping of page output delivered
 * to plugin observers at a Stage.
 *
 *   page_output.needs        which pages' output an observer has not seen
 *   page_output.record       what a running Stage delivered (pending)
 *   page_output.finish_plan  pages gone and placement counts changed
 *   page_output.commit_run   the Stage succeeded: its deliveries count
 *   page_output.discard_run  the Stage failed: its deliveries never happened
 *
 * Every op is the build's own (system): the plugin host calls them while it
 * serves the generator. Pending rows keep a failed build from marking pages
 * as seen, so the next Stage sends them again.
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonbParam } from "../sql-helpers.js";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const pageOutputNeedsOp = defineOperation({
  name: "page_output.needs",
  readScope: "request",
  // Why system-only: the build's own bookkeeping, called by the plugin host.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      pluginIds: z.array(uuid).min(1).max(32),
      pages: z
        .array(z.object({ pageId: uuid, htmlHash: hash }).strict())
        .min(1)
        .max(1000),
    })
    .strict(),
  output: z.object({
    needs: z.array(
      z.object({ pluginId: z.string(), pageId: z.string(), factsHash: z.string().nullable() }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT plugin_id::text AS plugin_id, page_id::text AS page_id, html_hash, facts_hash
      FROM plugin_page_observations
      WHERE plugin_id = ANY(${uuidArray(input.pluginIds)}) AND page_id = ANY(${uuidArray(input.pages.map((p) => p.pageId))})
    `)) as unknown as {
      plugin_id: string;
      page_id: string;
      html_hash: string;
      facts_hash: string;
    }[];
    const seen = new Map(rows.map((r) => [`${r.plugin_id}:${r.page_id}`, r] as const));
    const needs: { pluginId: string; pageId: string; factsHash: string | null }[] = [];
    for (const pluginId of input.pluginIds) {
      for (const page of input.pages) {
        const row = seen.get(`${pluginId}:${page.pageId}`);
        if (!row || row.html_hash !== page.htmlHash)
          needs.push({ pluginId, pageId: page.pageId, factsHash: row?.facts_hash ?? null });
      }
    }
    return ok({ needs });
  },
});

export const pageOutputRecordOp = defineOperation({
  name: "page_output.record",
  readScope: "request",
  // Why system-only: see page_output.needs.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      pluginId: uuid,
      pages: z
        .array(z.object({ pageId: uuid, htmlHash: hash, factsHash: hash }).strict())
        .min(1)
        .max(1000),
    })
    .strict(),
  output: z.object({ recorded: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO plugin_page_observation_pending (run_id, plugin_id, page_id, html_hash, facts_hash, removed)
      SELECT ${input.runId}::uuid, ${input.pluginId}::uuid, x.page_id, x.html_hash, x.facts_hash, false
      FROM jsonb_to_recordset(${jsonbParam(input.pages.map((p) => ({ page_id: p.pageId, html_hash: p.htmlHash, facts_hash: p.factsHash })))})
        AS x(page_id uuid, html_hash text, facts_hash text)
      ON CONFLICT (run_id, plugin_id, page_id)
        DO UPDATE SET html_hash = EXCLUDED.html_hash, facts_hash = EXCLUDED.facts_hash, removed = false
    `);
    return ok({ recorded: input.pages.length });
  },
});

export const pageOutputFinishPlanOp = defineOperation({
  name: "page_output.finish_plan",
  // Why site-wide: the pages an observer saw are compared with every page
  // the Stage built, once per Stage and observing plugin.
  readScope: "site",
  // Why system-only: see page_output.needs.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      pluginId: uuid,
      /** Every published page the Stage built. */
      builtPageIds: z.array(uuid).max(500_000),
      /** Placement count per module over the built pages. */
      moduleCounts: z.array(z.tuple([uuid, z.number().int().min(0)])).max(500_000),
    })
    .strict(),
  output: z.object({
    removed: z.array(z.string()),
    placementChanges: z.array(
      z.object({ moduleId: z.string(), before: z.number().int(), after: z.number().int() }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const observed = (await tx.execute(sql`
      SELECT page_id::text AS page_id FROM plugin_page_observations WHERE plugin_id = ${input.pluginId}::uuid
    `)) as unknown as { page_id: string }[];
    const built = new Set(input.builtPageIds);
    const removed = observed.map((r) => r.page_id).filter((id) => !built.has(id));
    if (removed.length > 0) {
      await tx.execute(sql`
        INSERT INTO plugin_page_observation_pending (run_id, plugin_id, page_id, removed)
        SELECT ${input.runId}::uuid, ${input.pluginId}::uuid, id, true FROM unnest(${uuidArray(removed)}) AS id
        ON CONFLICT (run_id, plugin_id, page_id) DO UPDATE SET removed = true, html_hash = NULL, facts_hash = NULL
      `);
    }
    const stored = (await tx.execute(sql`
      SELECT module_id::text AS module_id, placement_count FROM plugin_module_counts WHERE plugin_id = ${input.pluginId}::uuid
    `)) as unknown as { module_id: string; placement_count: number }[];
    const before = new Map(stored.map((r) => [r.module_id, r.placement_count] as const));
    const after = new Map(input.moduleCounts);
    const placementChanges: { moduleId: string; before: number; after: number }[] = [];
    for (const [moduleId, count] of after)
      if ((before.get(moduleId) ?? 0) !== count)
        placementChanges.push({ moduleId, before: before.get(moduleId) ?? 0, after: count });
    for (const [moduleId, count] of before)
      if (!after.has(moduleId) && count !== 0)
        placementChanges.push({ moduleId, before: count, after: 0 });
    await tx.execute(
      sql`DELETE FROM plugin_module_count_pending WHERE run_id = ${input.runId}::uuid AND plugin_id = ${input.pluginId}::uuid`,
    );
    if (input.moduleCounts.length > 0) {
      await tx.execute(sql`
        INSERT INTO plugin_module_count_pending (run_id, plugin_id, module_id, placement_count)
        SELECT ${input.runId}::uuid, ${input.pluginId}::uuid, x.module_id, x.n
        FROM jsonb_to_recordset(${jsonbParam(input.moduleCounts.map(([m, n]) => ({ module_id: m, n })))}) AS x(module_id uuid, n int)
      `);
    }
    return ok({ removed, placementChanges });
  },
});

export const pageOutputCommitRunOp = defineOperation({
  name: "page_output.commit_run",
  readScope: "request",
  // Why system-only: the Stage's finish step commits what it delivered.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({ pages: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    // One statement per step: data-modifying CTEs of one statement share a
    // snapshot, so a delete and an insert of the same key would collide.
    const gone = (await tx.execute(sql`
      DELETE FROM plugin_page_observations o USING plugin_page_observation_pending p
      WHERE p.run_id = ${input.runId}::uuid AND p.removed AND o.plugin_id = p.plugin_id AND o.page_id = p.page_id
      RETURNING o.page_id
    `)) as unknown as unknown[];
    const kept = (await tx.execute(sql`
      INSERT INTO plugin_page_observations (plugin_id, page_id, html_hash, facts_hash)
      SELECT plugin_id, page_id, html_hash, facts_hash FROM plugin_page_observation_pending
      WHERE run_id = ${input.runId}::uuid AND NOT removed
      ON CONFLICT (plugin_id, page_id) DO UPDATE SET html_hash = EXCLUDED.html_hash, facts_hash = EXCLUDED.facts_hash
      RETURNING page_id
    `)) as unknown as unknown[];
    await tx.execute(
      sql`DELETE FROM plugin_page_observation_pending WHERE run_id = ${input.runId}::uuid`,
    );
    await tx.execute(sql`
      DELETE FROM plugin_module_counts c
      USING (SELECT DISTINCT plugin_id FROM plugin_module_count_pending WHERE run_id = ${input.runId}::uuid) d
      WHERE c.plugin_id = d.plugin_id
    `);
    await tx.execute(sql`
      INSERT INTO plugin_module_counts (plugin_id, module_id, placement_count)
      SELECT plugin_id, module_id, placement_count FROM plugin_module_count_pending WHERE run_id = ${input.runId}::uuid
    `);
    await tx.execute(
      sql`DELETE FROM plugin_module_count_pending WHERE run_id = ${input.runId}::uuid`,
    );
    const delivered = [{ n: gone.length + kept.length }];
    return ok({ pages: delivered[0]?.n ?? 0 });
  },
});

export const pageOutputDiscardRunOp = defineOperation({
  name: "page_output.discard_run",
  readScope: "request",
  // Why system-only: the Stage's failure path drops what it delivered.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(
      sql`DELETE FROM plugin_page_observation_pending WHERE run_id = ${input.runId}::uuid`,
    );
    await tx.execute(
      sql`DELETE FROM plugin_module_count_pending WHERE run_id = ${input.runId}::uuid`,
    );
    return ok({});
  },
});

/** Every page-output op, for register.ts. */
export const PAGE_OUTPUT_OPS = [
  pageOutputNeedsOp,
  pageOutputRecordOp,
  pageOutputFinishPlanOp,
  pageOutputCommitRunOp,
  pageOutputDiscardRunOp,
] as const;
