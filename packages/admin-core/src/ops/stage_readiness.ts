// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.stage_readiness` — what a staging build would refuse right now,
 * in the caller's view of the site (main + its chat branch). The read
 * behind the "A Stage would be refused" note the AI gets at the start of a
 * turn and in the page tools' results (deploy/stage-readiness.ts).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  assessStageReadiness,
  type StageReadinessPage,
  stageReadinessSchema,
} from "../deploy/stage-readiness.js";
import { pageSeoViewSql } from "../seo/page-seo.js";
import { listPagesOp } from "./content/pages.js";

export const stageReadinessOp = defineOperation({
  name: "deploy.stage_readiness",
  // CLAUDE.md §11 — an open read: the AI plans its Stage with it.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: stageReadinessSchema,
  handler: async (ctx, _input, tx) => {
    // The chat's view of every page (its pending status / slug / move
    // changes applied) — exactly what pages.list reports, so the note and
    // list_pages never disagree.
    const listed = await listPagesOp.handler(ctx, { includeDeleted: false }, tx);
    if (!listed.ok) return listed;
    const pages = (
      listed.value as {
        pages: { id: string; title: string; currentPath: string; status: "draft" | "published" }[];
      }
    ).pages;
    // #1156 — the description in the same view: one the chat wrote is
    // pending on its branch and counts, as the Stage merges it first.
    const described = new Set<string>();
    if (pages.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT s.page_id::text AS page_id
        FROM ${pageSeoViewSql(
          ctx.chatBranchId,
          pages.map((p) => p.id),
        )} s
        WHERE btrim(coalesce(s.meta_description, '')) <> ''
      `)) as unknown as { page_id: string }[];
      for (const r of rows) described.add(r.page_id);
    }
    const view: StageReadinessPage[] = pages.map((p) => ({
      id: p.id,
      title: p.title,
      path: p.currentPath,
      status: p.status,
      hasMetaDescription: described.has(p.id),
    }));
    return ok(assessStageReadiness(view));
  },
});
