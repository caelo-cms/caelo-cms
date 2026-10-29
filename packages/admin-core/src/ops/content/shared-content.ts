// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — `pages.list_shared_content`: the content every page shares.
 *
 * Two kinds of placement show the same content on many pages:
 *
 * - LAYOUT placements (site chrome: header, footer, menus). Their content
 *   is the module's field defaults; one placement covers every page on
 *   the layout.
 * - SHARED content instances: a page placement synced to an instance
 *   other placements bind too (a CTA, a contact block).
 *
 * A plugin that gives pages different chrome per page — international-site
 * per language — plans against this list: what exists, what it says now
 * (to translate it, and to notice when it changed), and where it shows.
 *
 * Read as the caller's branch sees it (#1196). Since #1156 a chat's
 * chrome edits — a field added to the footer module, a module placed in
 * the header — are draft state on its branch until a Stage. A plugin
 * called from that chat writes its variants to the same branch, so it
 * must plan against the same view: reading main answered "up to date"
 * for a field the chat had just added. Outside a chat (Owner panel,
 * workers) this is the live state.
 *
 * Covered on a branch: layout placements (`effectiveLayoutModulesSql`),
 * module fields (pending module snapshots), modules, pages and content
 * instances created on the branch, and instance values (pending
 * content-instance snapshots).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  loadBranchedModuleStates,
  loadContentInstanceBranchStates,
} from "../../snapshots/index.js";
import { effectiveLayoutModulesSql } from "./layout-overlay.js";

const fieldShape = z.object({
  name: z.string(),
  kind: z.string(),
  default: z.unknown().optional(),
  /**
   * Epic #1107 — a `list` field's list type and binding, so a plugin
   * reads a local list's entries with their field definitions instead of
   * guessing which keys hold text.
   */
  listType: z.string().optional(),
  bind: z.enum(["local", "shared", "source"]).optional(),
});

function parseFields(raw: unknown): z.infer<typeof fieldShape>[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: z.infer<typeof fieldShape>[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object") continue;
    const o = f as {
      name?: unknown;
      kind?: unknown;
      default?: unknown;
      listType?: unknown;
      bind?: unknown;
    };
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      kind: typeof o.kind === "string" ? o.kind : "text",
      ...(o.default !== undefined ? { default: o.default } : {}),
      ...(typeof o.listType === "string" ? { listType: o.listType } : {}),
      ...(o.bind === "local" || o.bind === "shared" || o.bind === "source" ? { bind: o.bind } : {}),
    });
  }
  return out;
}

function defaultsOf(fields: readonly z.infer<typeof fieldShape>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * Overlays the branch's pending module changes onto rows read from the
 * live `modules` table: fields, slug and name as the branch has them; a
 * module the branch deleted drops out. Main (no branch) passes through.
 */
async function withBranchedModules<
  R extends { module_id: string; module_slug: string; module_name: string; fields: unknown },
>(tx: Tx, branchId: string | null, rows: readonly R[]): Promise<R[]> {
  if (!branchId || rows.length === 0) return [...rows];
  const states = await loadBranchedModuleStates(tx, branchId, [
    ...new Set(rows.map((r) => r.module_id)),
  ]);
  const out: R[] = [];
  for (const r of rows) {
    const s = states.get(r.module_id);
    if (!s) {
      out.push(r);
      continue;
    }
    if (s.deletedAt) continue;
    out.push({ ...r, module_slug: s.slug, module_name: s.displayName, fields: s.fields });
  }
  return out;
}

export const listSharedContentOp = defineOperation({
  name: "pages.list_shared_content",
  // Why system-only: the planning read behind plugin chrome variants
  // (international-site's translate_chrome / intl_status). The AI sees the
  // same content through the plugin's intl_status tool, phrased for the
  // job, and through get_layout / list_content_instances.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    layoutPlacements: z.array(
      z.object({
        layoutId: z.string(),
        layoutSlug: z.string(),
        blockName: z.string(),
        /** Index within the block, as the content-variants point keys it. */
        index: z.number().int(),
        moduleId: z.string(),
        moduleSlug: z.string(),
        moduleName: z.string(),
        fields: z.array(fieldShape),
        values: z.record(z.string(), z.unknown()),
      }),
    ),
    sharedInstances: z.array(
      z.object({
        contentInstanceId: z.string(),
        slug: z.string().nullable(),
        moduleId: z.string(),
        moduleSlug: z.string(),
        moduleName: z.string(),
        fields: z.array(fieldShape),
        values: z.record(z.string(), z.unknown()),
        pageIds: z.array(z.string()),
      }),
    ),
    /**
     * Epic #1107 — every content instance holding a LOCAL list (a module
     * field of kind `list`, bind local) with the pages it is placed on,
     * synced or not: a translation plugin translates those entries by
     * address (`instance/<id>/<field>/item/…`) for the languages of
     * exactly these pages. Values come from content_instances.list.
     */
    listInstances: z.array(
      z.object({ contentInstanceId: z.string(), pageIds: z.array(z.string()) }),
    ),
  }),
  handler: async (ctx, _input, tx) => {
    const branchId = ctx.chatBranchId ?? null;
    const visible = (alias: string) =>
      branchId
        ? sql`(${sql.raw(alias)}.chat_branch_id IS NULL OR ${sql.raw(alias)}.chat_branch_id = ${branchId}::uuid)`
        : sql`${sql.raw(alias)}.chat_branch_id IS NULL`;
    const layoutRows = await withBranchedModules(
      tx,
      branchId,
      (await tx.execute(sql`
        SELECT lm.layout_id::text AS layout_id, l.slug AS layout_slug, lm.block_name,
               m.id::text AS module_id, m.slug AS module_slug, m.display_name AS module_name,
               m.fields
        FROM (${effectiveLayoutModulesSql(branchId)}) lm
        JOIN layouts l ON l.id = lm.layout_id
        JOIN modules m ON m.id = lm.module_id
        WHERE m.deleted_at IS NULL AND ${visible("m")}
        ORDER BY lm.layout_id, lm.block_name ASC, lm.position ASC
      `)) as unknown as {
        layout_id: string;
        layout_slug: string;
        block_name: string;
        module_id: string;
        module_slug: string;
        module_name: string;
        fields: unknown;
      }[],
    );
    const indexOf = new Map<string, number>();
    const layoutPlacements = layoutRows.map((r) => {
      const blockKey = `${r.layout_id}|${r.block_name}`;
      const index = indexOf.get(blockKey) ?? 0;
      indexOf.set(blockKey, index + 1);
      const fields = parseFields(r.fields);
      return {
        layoutId: r.layout_id,
        layoutSlug: r.layout_slug,
        blockName: r.block_name,
        index,
        moduleId: r.module_id,
        moduleSlug: r.module_slug,
        moduleName: r.module_name,
        fields,
        values: defaultsOf(fields),
      };
    });

    const instanceRows = (await tx.execute(sql`
      SELECT ci.id::text AS id, ci.slug, ci."values" AS values,
             m.id::text AS module_id, m.slug AS module_slug, m.display_name AS module_name,
             m.fields,
             array_agg(DISTINCT pm.page_id::text) AS page_ids
      FROM page_modules pm
      JOIN content_instances ci ON ci.id = pm.content_instance_id
      JOIN modules m ON m.id = ci.module_id
      JOIN pages p ON p.id = pm.page_id
      WHERE pm.sync_mode = 'synced'
        AND ci.deleted_at IS NULL AND ${visible("ci")}
        AND p.deleted_at IS NULL AND ${visible("p")}
      GROUP BY ci.id, ci.slug, ci."values", m.id, m.slug, m.display_name, m.fields
      ORDER BY ci.id
    `)) as unknown as {
      id: string;
      slug: string | null;
      values: unknown;
      module_id: string;
      module_slug: string;
      module_name: string;
      fields: unknown;
      page_ids: string[] | string;
    }[];
    const branchedInstances = branchId
      ? await loadContentInstanceBranchStates(
          tx,
          instanceRows.map((r) => r.id),
          branchId,
        )
      : new Map();
    const sharedInstanceRows = (await withBranchedModules(tx, branchId, instanceRows)).filter(
      (r) => !branchedInstances.get(r.id)?.deletedAt,
    );
    const sharedInstances = sharedInstanceRows.map((r) => {
      const fields = parseFields(r.fields);
      const raw =
        branchedInstances.get(r.id)?.values ??
        (typeof r.values === "string" ? (JSON.parse(r.values) as unknown) : r.values);
      const pageIds = Array.isArray(r.page_ids)
        ? r.page_ids
        : String(r.page_ids)
            .replace(/^\{|\}$/g, "")
            .split(",")
            .filter(Boolean);
      return {
        contentInstanceId: r.id,
        slug: r.slug,
        moduleId: r.module_id,
        moduleSlug: r.module_slug,
        moduleName: r.module_name,
        fields,
        values: { ...defaultsOf(fields), ...((raw ?? {}) as Record<string, unknown>) },
        pageIds,
      };
    });
    const listRows = (await tx.execute(sql`
      SELECT pm.content_instance_id::text AS id,
             array_agg(DISTINCT pm.page_id::text) AS page_ids
      FROM page_modules pm
      JOIN content_instances ci ON ci.id = pm.content_instance_id
      JOIN modules m ON m.id = ci.module_id
      JOIN pages p ON p.id = pm.page_id
      WHERE ci.deleted_at IS NULL AND ${visible("ci")}
        AND p.deleted_at IS NULL AND ${visible("p")}
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.fields) = 'array' THEN m.fields ELSE '[]'::jsonb END
          ) f
          WHERE f->>'kind' = 'list' AND COALESCE(f->>'bind', 'local') = 'local'
        )
      GROUP BY pm.content_instance_id
      ORDER BY pm.content_instance_id
    `)) as unknown as { id: string; page_ids: string[] | string }[];
    const listInstances = listRows.map((r) => ({
      contentInstanceId: r.id,
      pageIds: Array.isArray(r.page_ids)
        ? r.page_ids
        : String(r.page_ids)
            .replace(/^\{|\}$/g, "")
            .split(",")
            .filter(Boolean),
    }));
    return ok({ layoutPlacements, sharedInstances, listInstances });
  },
});
