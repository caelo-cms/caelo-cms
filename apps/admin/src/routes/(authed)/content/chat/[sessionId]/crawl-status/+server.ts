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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  requirePermission(locals, "content.read");
  if (!locals.user) throw error(401, "Not authenticated");
  const runId = url.searchParams.get("runId");
  if (!runId || !UUID_RE.test(runId)) throw error(400, "runId must be a run UUID");

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.get", { runId });
  if (!r.ok) throw error(404, "run not found");

  const run = (
    r.value as {
      run: {
        id: string;
        status: string;
        maxPages: number;
        pagesSeen: number;
        pagesExtracted: number;
        errorMessage: string | null;
        chatSessionId: string | null;
      } | null;
    }
  ).run;
  // Security (review finding): scope the read to THIS chat. Without
  // the check any content.read user could poll arbitrary runs through
  // any session id. 404 for both missing and foreign runs — no
  // existence oracle. Runs proposed outside a chat (null session)
  // are not readable through this chat-scoped endpoint.
  if (!run || run.chatSessionId !== params.sessionId) throw error(404, "run not found");

  return json({
    runId: run.id,
    status: run.status,
    pagesExtracted: run.pagesExtracted,
    pagesSeen: run.pagesSeen,
    maxPages: run.maxPages,
    errorMessage: run.errorMessage,
  });
};
