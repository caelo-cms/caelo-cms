// SPDX-License-Identifier: MPL-2.0

/**
 * Render a page to composed HTML for the admin preview iframe.
 *
 * Read-only — no audit row, same convention as `users.list`. Returns an
 * object (per the existing `defineOperation` shape); the route handler
 * unwraps `html` into a `text/html` response.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { composePagePreview } from "../../preview/compose.js";

export const renderPagePreviewOp = defineOperation({
  name: "pages.render_preview",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ pageId: z.string().uuid() }),
  output: z.object({
    html: z.string(),
    replacedSlots: z.array(z.string()),
    missingSlots: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const pageRows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, t.html AS template_html, t.css AS template_css
      FROM pages p JOIN templates t ON t.id = p.template_id
      WHERE p.id = ${input.pageId}::uuid AND p.deleted_at IS NULL LIMIT 1
    `)) as unknown as { page_id: string; template_html: string; template_css: string }[];
    const pageRow = pageRows[0];
    if (!pageRow) {
      return err({
        kind: "HandlerError",
        operation: "pages.render_preview",
        message: "page not found",
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
    `)) as unknown as {
      block_name: string;
      position: number;
      module_id: string;
      slug: string;
      display_name: string;
      html: string;
      css: string;
      js: string;
    }[];

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

    const composed = composePagePreview({
      templateHtml: pageRow.template_html,
      templateCss: pageRow.template_css,
      blocks,
    });
    return ok({
      html: composed.html,
      replacedSlots: [...composed.replacedSlots],
      missingSlots: [...composed.missingSlots],
    });
  },
});
