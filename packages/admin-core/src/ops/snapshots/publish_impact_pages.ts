// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.79 — cascade-expansion op for incremental Stage.
 *
 * `chat.branch_change_count` (v0.2.76) reports what entities the
 * AI touched on a chat branch ("12 modules, 3 templates"), but the
 * static-generator needs the *page* set those edits affect:
 *   - Module edit → every page that uses the module (page_modules join).
 *   - Template edit → every page on that template.
 *   - Layout edit → every page on a template bound to that layout.
 *   - Structured-set edit → site-wide rebuild (templates reference
 *     menus implicitly today; v0.2.79+ adds a precise
 *     template_set_refs index, until then we stay conservative).
 *
 * Returns `{pageIds, fullSite}`. `fullSite=true` is a signal to
 * triggerDeployOp that no `changedPageIds` filter should be passed
 * (re-bake everything).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidArrayLiteral(ids: ReadonlyArray<string>): string {
  // Defense-in-depth — Zod has already validated each entry as a
  // UUID, but assert again before inlining into raw SQL so a future
  // schema relaxation can't open an injection path.
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`uuidArrayLiteral: not a UUID: ${id}`);
  }
  if (ids.length === 0) return "ARRAY[]";
  return `ARRAY[${ids.map((id) => `'${id}'`).join(",")}]`;
}

const inputSchema = z
  .object({
    moduleIds: z.array(z.string().uuid()).default([]),
    templateIds: z.array(z.string().uuid()).default([]),
    layoutIds: z.array(z.string().uuid()).default([]),
    /** Slugs of structured_sets touched on the chat branch. Each one
     *  triggers a full-site rebuild because templates reference menus
     *  / theme tokens implicitly today. */
    structuredSetSlugs: z.array(z.string()).default([]),
    /** Optional locale filter — when set, the cascade restricts to
     *  pages in this locale. Useful for "translate one locale only"
     *  flows. Empty/undefined = all locales. */
    locale: z.string().optional(),
  })
  .strict();

export const publishImpactPagesOp = defineOperation({
  name: "snapshots.publish_impact_pages",
  // CLAUDE.md §11: AI calls this before deploy.trigger to plan the
  // smallest possible Stage. Read-only.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: inputSchema,
  output: z.object({
    pageIds: z.array(z.string()),
    fullSite: z.boolean(),
    breakdown: z.object({
      fromModules: z.number().int().nonnegative(),
      fromTemplates: z.number().int().nonnegative(),
      fromLayouts: z.number().int().nonnegative(),
    }),
  }),
  handler: async (_ctx, input, tx) => {
    // Fast paths.
    if (input.structuredSetSlugs.length > 0) {
      return ok({
        pageIds: [],
        fullSite: true,
        breakdown: { fromModules: 0, fromTemplates: 0, fromLayouts: 0 },
      });
    }
    if (
      input.moduleIds.length === 0 &&
      input.templateIds.length === 0 &&
      input.layoutIds.length === 0
    ) {
      return ok({
        pageIds: [],
        fullSite: false,
        breakdown: { fromModules: 0, fromTemplates: 0, fromLayouts: 0 },
      });
    }

    // Inline UUIDs as quoted literals — Zod has already validated
    // them as UUID strings so no SQL-injection surface. Drizzle's
    // bound-array interpolation through bun-sql doesn't translate
    // JS arrays to PG `array_in` cleanly here (works for static-
    // generator's same-shape query but trips inside transactions —
    // tracked but not blocking; the inline form sidesteps it).
    type Row = { page_id: string; src: "module" | "template" | "layout" };
    const localeFilter = input.locale ? sql`AND p.locale = ${input.locale}` : sql.raw("");
    const moduleArr = uuidArrayLiteral(input.moduleIds);
    const templateArr = uuidArrayLiteral(input.templateIds);
    const layoutArr = uuidArrayLiteral(input.layoutIds);

    const moduleCte =
      input.moduleIds.length > 0
        ? sql`SELECT DISTINCT pm.page_id::text AS page_id, 'module'::text AS src
              FROM page_modules pm
              JOIN pages p ON p.id = pm.page_id AND p.deleted_at IS NULL
              WHERE pm.module_id = ANY(${sql.raw(moduleArr)}::uuid[])
              ${localeFilter}`
        : sql`SELECT NULL::text AS page_id, NULL::text AS src WHERE FALSE`;

    const templateCte =
      input.templateIds.length > 0
        ? sql`SELECT DISTINCT p.id::text AS page_id, 'template'::text AS src
              FROM pages p
              WHERE p.template_id = ANY(${sql.raw(templateArr)}::uuid[])
                AND p.deleted_at IS NULL
              ${localeFilter}`
        : sql`SELECT NULL::text AS page_id, NULL::text AS src WHERE FALSE`;

    const layoutCte =
      input.layoutIds.length > 0
        ? sql`SELECT DISTINCT p.id::text AS page_id, 'layout'::text AS src
              FROM pages p
              JOIN templates t ON t.id = p.template_id
              WHERE t.layout_id = ANY(${sql.raw(layoutArr)}::uuid[])
                AND p.deleted_at IS NULL
              ${localeFilter}`
        : sql`SELECT NULL::text AS page_id, NULL::text AS src WHERE FALSE`;

    const rows = (await tx.execute(sql`
      ${moduleCte}
      UNION ALL ${templateCte}
      UNION ALL ${layoutCte}
    `)) as unknown as Row[];

    const pageIdSet = new Set<string>();
    let fromModules = 0;
    let fromTemplates = 0;
    let fromLayouts = 0;
    for (const r of rows) {
      pageIdSet.add(r.page_id);
      if (r.src === "module") fromModules += 1;
      else if (r.src === "template") fromTemplates += 1;
      else fromLayouts += 1;
    }

    return ok({
      pageIds: [...pageIdSet],
      fullSite: false,
      breakdown: {
        fromModules,
        fromTemplates,
        fromLayouts,
      },
    });
  },
});
