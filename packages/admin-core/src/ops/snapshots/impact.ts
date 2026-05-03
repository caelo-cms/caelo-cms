// SPDX-License-Identifier: MPL-2.0

import { defineOperation } from "@caelo-cms/query-api";
import { err, moduleImpactInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { classifySeverity, defaultTemplateBlockIsHeader } from "../../snapshots/index.js";

const affectedPageSchema = z.object({
  pageId: z.string(),
  pageSlug: z.string(),
  pageLocale: z.string(),
  templateId: z.string(),
  templateSlug: z.string(),
  blockName: z.string(),
});

/**
 * "If I change this module, what will it affect?" — used by the Advanced
 * History drawer impact preview and (in P5) by the AI-edit confirm step.
 *
 * Returns the affected pages joined to their parent templates plus the
 * computed severity. The thumbnailer-driven refinement lands in P6.
 */
export const moduleImpactOp = defineOperation({
  name: "snapshots.module_impact",
  // CLAUDE.md §11: AI checks blast radius before suggesting an edit.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: moduleImpactInput,
  output: z.object({
    moduleId: z.string(),
    affectedPages: z.array(affectedPageSchema),
    severity: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const exists = (await tx.execute(sql`
      SELECT 1 FROM modules WHERE id = ${input.moduleId}::uuid LIMIT 1
    `)) as unknown as { exists: number }[];
    if (exists.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "snapshots.module_impact",
        message: "module not found",
      });
    }

    const rows = (await tx.execute(sql`
      SELECT p.id::text AS page_id, p.slug AS page_slug, p.locale AS page_locale,
             t.id::text AS template_id, t.slug AS template_slug,
             pm.block_name AS block_name
      FROM page_modules pm
      JOIN pages p ON p.id = pm.page_id AND p.deleted_at IS NULL
      JOIN templates t ON t.id = p.template_id
      WHERE pm.module_id = ${input.moduleId}::uuid
      ORDER BY p.slug, p.locale, pm.block_name
    `)) as unknown as {
      page_id: string;
      page_slug: string;
      page_locale: string;
      template_id: string;
      template_slug: string;
      block_name: string;
    }[];

    const affectedPages = rows.map((r) => ({
      pageId: r.page_id,
      pageSlug: r.page_slug,
      pageLocale: r.page_locale,
      templateId: r.template_id,
      templateSlug: r.template_slug,
      blockName: r.block_name,
    }));

    const { severity, reasons } = classifySeverity({
      affectedPages: affectedPages.map((p) => ({
        pageId: p.pageId,
        templateId: p.templateId,
        blockName: p.blockName,
      })),
      templateBlockIsHeader: defaultTemplateBlockIsHeader,
    });

    return ok({
      moduleId: input.moduleId,
      affectedPages,
      severity,
      reasons: [...reasons],
    });
  },
});
