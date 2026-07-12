// SPDX-License-Identifier: MPL-2.0

/**
 * issue #228 — live crawl status for the chat's progress strip (route deliberately named crawl-status: knip's regex-based svelte script extractor chokes on the substring `import` in .svelte files).
 *
 * After the operator approves a site-import proposal, ChatPanel polls
 * this endpoint (proposalId == runId) to (a) render "Crawling… n/max
 * pages" above the composer and (b) auto-post the continuation nudge
 * the moment the run reaches ready_for_review — the operator must
 * never have to type "check status" to unstick the AI (operator
 * feedback 2026-07-12: "the ai should update me not i a user him").
 *
 * Thin read-projection over imports.get; GET only.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  requirePermission(locals, "content.read");
  if (!locals.user) throw error(401, "Not authenticated");
  const runId = url.searchParams.get("runId");
  if (!runId) throw error(400, "runId query param required");

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.get", { runId });
  if (!r.ok) throw error(400, `imports.get failed: ${r.error.kind}`);

  const run = (
    r.value as {
      run: {
        id: string;
        status: string;
        maxPages: number;
        pagesSeen: number;
        pagesExtracted: number;
        errorMessage: string | null;
      } | null;
    }
  ).run;
  if (!run) throw error(404, "run not found");

  return json({
    runId: run.id,
    status: run.status,
    pagesExtracted: run.pagesExtracted,
    pagesSeen: run.pagesSeen,
    maxPages: run.maxPages,
    errorMessage: run.errorMessage,
  });
};
