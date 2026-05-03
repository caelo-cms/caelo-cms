// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — per-run review surface. Lists extracted pages with Accept /
 * (future) Reject actions, and a Cleanup button.
 */

import { execute } from "@caelo/query-api";
import { error, fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface ImportRun {
  id: string;
  sourceUrl: string;
  status: string;
  pagesSeen: number;
  pagesExtracted: number;
  createdAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

interface ImportPage {
  id: string;
  sourceUrl: string;
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
  rejectedAt: string | null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.get", {
    runId: params.runId,
  });
  if (!r.ok) throw error(404, "Run not found");
  const v = r.value as { run: ImportRun | null; pages: ImportPage[] };
  if (!v.run) throw error(404, "Run not found");

  // Pull the default template for the Accept action — Owner can swap
  // later via change_template.
  const sd = await execute(registry, adapter, locals.ctx, "site_defaults.get", {});
  const defaultTemplateId = sd.ok
    ? ((sd.value as { defaults: { defaultTemplateId: string | null } | null }).defaults
        ?.defaultTemplateId ?? null)
    : null;
  return { run: v.run, pages: v.pages, defaultTemplateId };
};

export const actions: Actions = {
  accept: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const importPageId = form.get("importPageId");
    const templateId = form.get("templateId");
    if (typeof importPageId !== "string" || typeof templateId !== "string") {
      return fail(400, { error: "importPageId + templateId required" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.accept_page", {
      importPageId,
      templateId,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    const v = r.value as { pageId: string };
    return { ok: true, message: `Promoted to draft page ${v.pageId.slice(0, 8)}.` };
  },
  cleanup: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const runId = form.get("runId");
    if (typeof runId !== "string") return fail(400, { error: "runId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.cleanup_run", {
      runId,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Run cleaned up. Accepted pages stay; un-accepted rows dropped." };
  },
};
