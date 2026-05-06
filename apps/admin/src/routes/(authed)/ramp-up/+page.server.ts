// SPDX-License-Identifier: MPL-2.0

/**
 * P19 — Ramp Up wizard. Owner-facing flow for getting a fresh Caelo
 * install populated from an existing site URL in five clicks:
 *
 *   1. Welcome + URL input → calls `imports.create_run` (Owner-direct;
 *      goes straight to status='crawling', skipping the AI propose
 *      gate since the Owner is initiating).
 *   2. Crawling — page polls `imports.get` every 2s.
 *   3. Review — Owner sees extracted pages + screenshot diffs.
 *   4. Synthesise — clicks the button, server calls
 *      `imports.compose_from_run` to materialise theme + template +
 *      pages + modules in one transaction.
 *   5. Done — link to /edit?page=<homepageId> for the publish flow.
 *
 * The page is one route; query params (`runId`, `step`) drive the
 * step rendered. Resume-able: the Owner can navigate away and come
 * back via /ramp-up?runId=... at any point.
 */

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

type RunStatus = "proposed" | "crawling" | "ready_for_review" | "completed" | "failed";

interface ImportRun {
  id: string;
  sourceUrl: string;
  depth: number;
  maxPages: number;
  status: RunStatus;
  pagesSeen: number;
  pagesExtracted: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface ImportPage {
  id: string;
  proposedSlug: string;
  proposedTitle: string;
  proposedModules: Array<{
    blockName: string;
    position: number;
    html: string;
    displayName: string;
  }>;
  proposedThemeTokens: Record<string, string>;
  diffStatus: "pass" | "warn" | "fail" | null;
  diffPct: number | null;
  acceptedPageId: string | null;
  acceptedAt: string | null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.write");
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return { step: "welcome" as const };
  }
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.get", { runId });
  if (!r.ok) {
    return { step: "welcome" as const, error: `Import run not found (${r.error.kind}).` };
  }
  const data = r.value as { run: ImportRun; pages: ImportPage[] };
  return {
    step: stepFromStatus(data.run.status),
    run: data.run,
    pages: data.pages,
  };
};

/**
 * Map the import_runs.status enum → wizard step. The wizard's
 * "synthesised" step (status='completed' with accepted pages present)
 * is a separate UI; we infer it by checking whether any page row has
 * `accepted_page_id` set.
 */
function stepFromStatus(status: RunStatus): "welcome" | "crawling" | "review" | "failed" {
  switch (status) {
    case "proposed": // shouldn't happen — wizard skips the propose gate
      return "crawling";
    case "crawling":
      return "crawling";
    case "ready_for_review":
      return "review";
    case "completed":
      return "review";
    case "failed":
      return "failed";
  }
}

export const actions: Actions = {
  start: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
    const depth = Number.parseInt(String(form.get("depth") ?? "2"), 10);
    const maxPages = Number.parseInt(String(form.get("maxPages") ?? "20"), 10);
    if (!sourceUrl) return fail(400, { error: "Enter a URL to import." });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.create_run", {
      sourceUrl,
      depth,
      maxPages,
    });
    if (!r.ok) return fail(400, { error: `Could not start crawl (${r.error.kind}).` });
    const runId = (r.value as { runId: string }).runId;
    throw redirect(303, `/ramp-up?runId=${runId}`);
  },

  compose: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const runId = String(form.get("runId") ?? "").trim();
    if (!runId) return fail(400, { error: "Missing runId." });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.compose_from_run", {
      runId,
    });
    if (!r.ok) return fail(400, { error: `Synthesis failed (${r.error.kind}).` });
    const v = r.value as {
      themeTokensApplied: number;
      layoutId: string;
      templateId: string;
      pageIds: string[];
      homepageId: string | null;
      skippedAlreadyAccepted: number;
    };
    return {
      ok: true,
      composed: true,
      themeTokensApplied: v.themeTokensApplied,
      pageCount: v.pageIds.length,
      homepageId: v.homepageId,
      templateId: v.templateId,
    };
  },
};
