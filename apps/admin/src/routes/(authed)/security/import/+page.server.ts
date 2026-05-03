// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — Site Import Wizard list / new-run.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface ImportRun {
  id: string;
  sourceUrl: string;
  depth: number;
  maxPages: number;
  status: "proposed" | "crawling" | "ready_for_review" | "completed" | "failed";
  pagesSeen: number;
  pagesExtracted: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.list", {});
  const runs = r.ok ? (r.value as { runs: ImportRun[] }).runs : [];
  return { runs, error: r.ok ? null : r.error.kind };
};

export const actions: Actions = {
  startCrawl: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const sourceUrl = (form.get("sourceUrl") as string) ?? "";
    const depth = Number.parseInt((form.get("depth") as string) ?? "2", 10);
    const maxPages = Number.parseInt((form.get("maxPages") as string) ?? "50", 10);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.create_run", {
      sourceUrl,
      depth,
      maxPages,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    const v = r.value as { runId: string };
    return {
      ok: true,
      message: `Crawl queued (run ${v.runId.slice(0, 8)}). Open the row to follow progress; the worker picks it up within 10s.`,
    };
  },
};
