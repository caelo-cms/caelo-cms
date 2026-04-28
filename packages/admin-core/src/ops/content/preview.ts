// SPDX-License-Identifier: MPL-2.0

/**
 * Render a page to composed HTML for the admin preview iframe.
 *
 * Read-only — no audit row, same convention as `users.list`. Returns an
 * object (per the existing `defineOperation` shape); the route handler
 * unwraps `html` into a `text/html` response.
 *
 * P6.7 — accepts an optional `chatBranchId`. When set, every module
 * referenced by the page is resolved against the latest branch snapshot
 * for that branch (P5 schema); modules with no branch snapshot fall
 * back to the live `modules` row. Lets the live-edit overlay's iframe
 * render the post-AI-edit view of a page without requiring publish.
 */

import { defineOperation } from "@caelo/query-api";
import { ComposeError, composePageWithLayout, err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  parseAndUpgradeModuleState,
  parseSnapshotState,
  SnapshotSchemaError,
} from "../../snapshots/index.js";

interface ModuleSourceRow {
  block_name: string;
  position: number;
  module_id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  js: string;
}

interface BranchSnapshotRow {
  module_id: string;
  state: unknown;
}

export const renderPagePreviewOp = defineOperation({
  name: "pages.render_preview",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      chatBranchId: z.string().uuid().optional(),
      /**
       * P6.6b deferred — module ids whose branch state should be
       * skipped when rendering. The right pane of the chat-side diff
       * uses this to reveal what the page would look like if a
       * specific module's pending edit were rolled back, while the
       * rest of the branch's edits stay applied. Ignored when
       * `chatBranchId` is omitted.
       */
      excludeBranchModules: z.array(z.string().uuid()).optional(),
    })
    .strict(),
  output: z.object({
    html: z.string(),
    replacedSlots: z.array(z.string()),
    missingSlots: z.array(z.string()),
    pageSlug: z.string(),
    pageLocale: z.string(),
  }),
  handler: async (_ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, p.slug AS slug, p.locale AS locale,
             t.html AS template_html, t.css AS template_css,
             l.id::text AS layout_id, l.slug AS layout_slug,
             l.html AS layout_html, l.css AS layout_css
      FROM pages p
      JOIN templates t ON t.id = p.template_id
      JOIN layouts l   ON l.id = t.layout_id
      WHERE p.id = ${input.pageId}::uuid AND p.deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      page_id: string;
      slug: string;
      locale: string;
      template_html: string;
      template_css: string;
      layout_id: string;
      layout_slug: string;
      layout_html: string;
      layout_css: string;
    }[];
    const pageRow = pageRows[0];
    if (!pageRow) {
      return err({
        kind: "HandlerError",
        operation: "pages.render_preview",
        message: "page not found",
      });
    }
    // P6.7.6 no-fallbacks invariant — the layout must declare a
    // `content` block (the slot the template renders into). Surface a
    // loud error if it doesn't, instead of silently producing chrome
    // with no body.
    const layoutBlocksRows = (await tx.execute(sql`
      SELECT name FROM layout_blocks WHERE layout_id = ${pageRow.layout_id}::uuid
    `)) as unknown as { name: string }[];
    if (!layoutBlocksRows.some((r) => r.name === "content")) {
      return err({
        kind: "HandlerError",
        operation: "pages.render_preview",
        message: `layout "${pageRow.layout_slug}" is missing the required \`content\` block — fix via /security/layouts`,
      });
    }

    const modRows = (await tx.execute(sql`
      SELECT pm.block_name AS block_name,
             pm.position AS position,
             m.id::text AS module_id,
             m.slug AS slug,
             m.display_name AS display_name,
             m.html AS html,
             m.css AS css,
             m.js AS js
      FROM page_modules pm JOIN modules m ON m.id = pm.module_id
      WHERE pm.page_id = ${input.pageId}::uuid AND m.deleted_at IS NULL
      ORDER BY pm.block_name ASC, pm.position ASC
    `)) as unknown as ModuleSourceRow[];

    // P6.7 — branch-aware overlay. For each module referenced by this
    // page, look up the latest branch snapshot in the requested branch;
    // if found, swap its state in for the live module row. Modules with
    // no branch snapshot keep their live values.
    const excludeSet = new Set(input.excludeBranchModules ?? []);
    if (input.chatBranchId && modRows.length > 0) {
      const branchRows = (await tx.execute(sql`
        SELECT DISTINCT ON (ms.module_id) ms.module_id::text AS module_id, ms.state
        FROM module_snapshots ms
        JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
        WHERE ss.chat_branch_id = ${input.chatBranchId}::uuid
          AND ms.module_id::text IN (${sql.join(
            modRows.map((r) => sql`${r.module_id}`),
            sql`, `,
          )})
        ORDER BY ms.module_id, ss.created_at DESC
      `)) as unknown as BranchSnapshotRow[];
      const branchByModule = new Map<string, BranchSnapshotRow>();
      for (const r of branchRows) branchByModule.set(r.module_id, r);
      try {
        for (const m of modRows) {
          // P6.6b — skip the branch overlay for excluded modules so
          // the right diff pane shows what the page would look like
          // with this specific module's pending edit rolled back.
          if (excludeSet.has(m.module_id)) continue;
          const b = branchByModule.get(m.module_id);
          if (!b) continue;
          const state = parseAndUpgradeModuleState(parseSnapshotState(b.state));
          if (state.deletedAt) continue; // soft-deleted in the branch
          m.html = state.html;
          m.css = state.css;
          m.js = state.js;
          m.display_name = state.displayName;
          m.slug = state.slug;
        }
      } catch (e) {
        if (e instanceof SnapshotSchemaError) {
          return err({
            kind: "HandlerError",
            operation: "pages.render_preview",
            message: `branch snapshot schema mismatch: ${e.message}`,
          });
        }
        throw e;
      }
    }

    const grouped = new Map<
      string,
      {
        moduleId: string;
        slug: string;
        displayName: string;
        html: string;
        css: string;
        js: string;
      }[]
    >();
    for (const r of modRows) {
      const arr = grouped.get(r.block_name) ?? [];
      arr.push({
        moduleId: r.module_id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        js: r.js,
      });
      grouped.set(r.block_name, arr);
    }
    const blocks = [...grouped.entries()].map(([blockName, modules]) => ({
      blockName,
      modules,
    }));

    // P6.7.5 — load structured sets (theme + nav-menu + others) so the
    // composer can render nav menus from typed items + inject theme
    // tokens into <head>.
    const setRows = (await tx.execute(sql`
      SELECT kind, slug, items::text AS items FROM structured_sets
    `)) as unknown as { kind: string; slug: string; items: string }[];
    const byKindSlug: Record<string, unknown[]> = {};
    for (const r of setRows) {
      try {
        byKindSlug[`${r.kind}/${r.slug}`] = JSON.parse(r.items) as unknown[];
      } catch {
        // ignore malformed rows
      }
    }

    // P6.7.6 — load layout modules (chrome) for every layout block
    // except `content` (which is filled by the rendered template).
    const layoutModRows = (await tx.execute(sql`
      SELECT lm.block_name AS block_name,
             lm.position   AS position,
             m.id::text    AS module_id,
             m.slug        AS slug,
             m.display_name AS display_name,
             m.html        AS html,
             m.css         AS css,
             m.js          AS js
      FROM layout_modules lm JOIN modules m ON m.id = lm.module_id
      WHERE lm.layout_id = ${pageRow.layout_id}::uuid AND m.deleted_at IS NULL
      ORDER BY lm.block_name ASC, lm.position ASC
    `)) as unknown as ModuleSourceRow[];
    const layoutGrouped = new Map<
      string,
      {
        moduleId: string;
        slug: string;
        displayName: string;
        html: string;
        css: string;
        js: string;
      }[]
    >();
    for (const r of layoutModRows) {
      const arr = layoutGrouped.get(r.block_name) ?? [];
      arr.push({
        moduleId: r.module_id,
        slug: r.slug,
        displayName: r.display_name,
        html: r.html,
        css: r.css,
        js: r.js,
      });
      layoutGrouped.set(r.block_name, arr);
    }
    const layoutBlocks = [...layoutGrouped.entries()].map(([blockName, modules]) => ({
      blockName,
      modules,
    }));

    let composed: ReturnType<typeof composePageWithLayout>;
    try {
      composed = composePageWithLayout({
        templateHtml: pageRow.template_html,
        templateCss: pageRow.template_css,
        blocks,
        structuredSets: { byKindSlug },
        layoutHtml: pageRow.layout_html,
        layoutCss: pageRow.layout_css,
        layoutBlocks,
        layoutSlug: pageRow.layout_slug,
      });
    } catch (e) {
      if (e instanceof ComposeError) {
        return err({
          kind: "HandlerError",
          operation: "pages.render_preview",
          message: e.message,
        });
      }
      throw e;
    }
    return ok({
      html: composed.html,
      replacedSlots: [...composed.replacedSlots],
      missingSlots: [...composed.missingSlots],
      pageSlug: pageRow.slug,
      pageLocale: pageRow.locale,
    });
  },
});
