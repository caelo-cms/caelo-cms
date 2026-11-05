// SPDX-License-Identifier: MPL-2.0

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { err, moduleImpactInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { classifySeverity, defaultTemplateBlockIsHeader } from "../../snapshots/index.js";
import { findModuleHolders, placementRowsOfModules } from "../content/module-placements.js";

const affectedPageSchema = z.object({
  pageId: z.string(),
  pageSlug: z.string(),
  templateId: z.string(),
  templateSlug: z.string(),
  blockName: z.string(),
});

/** Placements one call lists; `affectedPagesCapped` says when there are more. */
const IMPACT_PLACEMENT_CAP = 200;

/** Parent instances one call reads: enough to name the parents. */
const IMPACT_NESTED_INSTANCES = 20;

/**
 * "If I change this module, what will it affect?" — used by the Advanced
 * History drawer impact preview and (in P5) by the AI-edit confirm step.
 *
 * Returns the affected pages joined to their parent templates plus the
 * computed severity. The thumbnailer-driven refinement lands in P6.
 *
 * #1424 — reads the caller's view (`module-placements.ts`, the view of the
 * delete guard and of `list_modules`): this chat's unstaged placements
 * count, pages on another chat's isolated branch do not, and the layouts
 * and parent modules that hold the module count towards the severity. A
 * module in site chrome is on every page of its layout whatever its page
 * rows say. Bounded at `IMPACT_PLACEMENT_CAP` placements.
 */
export const moduleImpactOp = defineOperation({
  name: "snapshots.module_impact",
  readScope: "request",
  // CLAUDE.md §11: AI checks blast radius before suggesting an edit.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: moduleImpactInput,
  output: z.object({
    moduleId: z.string(),
    affectedPages: z.array(affectedPageSchema),
    /** More placements exist than `affectedPages` lists. */
    affectedPagesCapped: z.boolean(),
    /** Layouts whose chrome holds the module. */
    layouts: z.array(z.string()),
    /** Slugs of parent modules that nest it (a sample when many instances do). */
    nestedIn: z.array(z.string()),
    severity: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
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

    const branchId = ctx.chatBranchId ?? null;
    const rows = await placementRowsOfModules(
      tx,
      branchId,
      [input.moduleId],
      IMPACT_PLACEMENT_CAP + 1,
    );
    const capped = rows.length > IMPACT_PLACEMENT_CAP;
    const listed = rows
      .slice()
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.blockName.localeCompare(b.blockName))
      .slice(0, IMPACT_PLACEMENT_CAP);
    const templates =
      listed.length === 0
        ? []
        : ((await tx.execute(sql`
            SELECT id::text AS id, slug FROM templates
             WHERE id = ANY(${uuidArray([...new Set(listed.map((r) => r.templateId))])})
          `)) as unknown as { id: string; slug: string }[]);
    const templateSlug = new Map(templates.map((t) => [t.id, t.slug]));

    const affectedPages = listed.map((r) => ({
      pageId: r.pageId,
      pageSlug: r.slug,
      templateId: r.templateId,
      templateSlug: templateSlug.get(r.templateId) ?? "",
      blockName: r.blockName,
    }));

    const holders = (
      await findModuleHolders(tx, branchId, [input.moduleId], IMPACT_NESTED_INSTANCES)
    ).get(input.moduleId);
    const layouts = [...(holders?.layouts ?? [])];
    const nestedIn = [...(holders?.nestedIn ?? [])];

    const { severity, reasons } = classifySeverity({
      affectedPages: affectedPages.map((p) => ({
        pageId: p.pageId,
        templateId: p.templateId,
        blockName: p.blockName,
      })),
      capped,
      layouts,
      nestedIn,
      templateBlockIsHeader: defaultTemplateBlockIsHeader,
    });

    return ok({
      moduleId: input.moduleId,
      affectedPages,
      affectedPagesCapped: capped,
      layouts,
      nestedIn,
      severity,
      reasons: [...reasons],
    });
  },
});
