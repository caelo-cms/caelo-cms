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
 * Main-line state only: chrome variants describe the live site, and the
 * content-variants composition point resolves branch rendering itself.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const fieldShape = z.object({
  name: z.string(),
  kind: z.string(),
  default: z.unknown().optional(),
});

function parseFields(raw: unknown): z.infer<typeof fieldShape>[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: z.infer<typeof fieldShape>[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== "object") continue;
    const o = f as { name?: unknown; kind?: unknown; default?: unknown };
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      kind: typeof o.kind === "string" ? o.kind : "text",
      ...(o.default !== undefined ? { default: o.default } : {}),
    });
  }
  return out;
}

function defaultsOf(fields: readonly z.infer<typeof fieldShape>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.name] = f.default;
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
  }),
  handler: async (_ctx, _input, tx) => {
    const layoutRows = (await tx.execute(sql`
      SELECT lm.layout_id::text AS layout_id, l.slug AS layout_slug, lm.block_name,
             m.id::text AS module_id, m.slug AS module_slug, m.display_name AS module_name,
             m.fields
      FROM layout_modules lm
      JOIN layouts l ON l.id = lm.layout_id
      JOIN modules m ON m.id = lm.module_id
      WHERE m.deleted_at IS NULL AND m.chat_branch_id IS NULL
      ORDER BY lm.layout_id, lm.block_name ASC, lm.position ASC
    `)) as unknown as {
      layout_id: string;
      layout_slug: string;
      block_name: string;
      module_id: string;
      module_slug: string;
      module_name: string;
      fields: unknown;
    }[];
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
        AND ci.deleted_at IS NULL AND ci.chat_branch_id IS NULL
        AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
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
    const sharedInstances = instanceRows.map((r) => {
      const fields = parseFields(r.fields);
      const raw = typeof r.values === "string" ? (JSON.parse(r.values) as unknown) : r.values;
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
    return ok({ layoutPlacements, sharedInstances });
  },
});
