// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface MatrixRow {
  slug: string;
  locale: string;
  status: "source" | "up_to_date" | "needs_update" | "not_started";
  pageId: string | null;
  sourcePageId: string;
  localeDisplayName: string;
  isSource: boolean;
}

interface JobRow {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
  totalUnits: number;
  completedUnits: number;
  erroredUnits: number;
  costMicrocents: number;
  capMicrocents: number | null;
  errorSummary: string | null;
  createdAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const matrixR = await execute(
    registry,
    adapter,
    locals.ctx,
    "pages.translation_status_matrix",
    {},
  );
  const jobsR = await execute(registry, adapter, locals.ctx, "translation_jobs.list", {
    status: "any",
    limit: 50,
  });
  const matrix = matrixR.ok ? (matrixR.value as { rows: MatrixRow[] }).rows : [];
  const jobs = jobsR.ok ? (jobsR.value as { jobs: JobRow[] }).jobs : [];

  // Pivot: pages × locales for the table render. Keep source rows out
  // of the locale columns; source slug owns the leftmost column.
  const slugs = [...new Set(matrix.map((r) => r.slug))].sort();
  const localesAll = matrix.map((r) => ({ code: r.locale, displayName: r.localeDisplayName }));
  const localesUnique = [...new Map(localesAll.map((l) => [l.code, l])).values()].sort((a, b) =>
    a.code.localeCompare(b.code),
  );
  const cellsByKey: Record<string, MatrixRow> = {};
  for (const r of matrix) cellsByKey[`${r.slug}|${r.locale}`] = r;

  // Total stale-ish count for the bulk strip.
  const staleCount = matrix.filter(
    (r) => r.status === "not_started" || r.status === "needs_update",
  ).length;
  const activeJob = jobs.find((j) => j.status === "running" || j.status === "pending");
  // Most recent completed job — surface a "Publish all completed"
  // button so the editor can promote a fresh batch of drafts in one
  // click after review.
  const recentCompletedJob = jobs.find((j) => j.status === "completed" && j.completedUnits > 0);

  return {
    slugs,
    locales: localesUnique,
    cellsByKey,
    jobs,
    staleCount,
    activeJob,
    recentCompletedJob,
  };
};

export const actions: Actions = {
  bulkAllStale: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "translation_jobs.create", {
      scope: { kind: "all-stale" },
    });
    if (!r.ok) {
      const m =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "queue failed";
      return fail(400, { error: m });
    }
    const v = r.value as { jobId: string; totalUnits: number };
    return {
      ok: true,
      message: `Queued ${v.totalUnits} translation${v.totalUnits === 1 ? "" : "s"}.`,
    };
  },

  translateOne: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const pageId = String(form.get("pageId") ?? "");
    const targetLocale = String(form.get("targetLocale") ?? "");
    const mode = String(form.get("mode") ?? "");
    const opName = mode === "mode_2" ? "translation.mode_2" : "translation.mode_1";
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, opName, {
      pageId,
      targetLocale,
    });
    if (!r.ok) {
      const m =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "translation failed";
      return fail(400, { error: m });
    }
    return {
      ok: true,
      message:
        mode === "mode_2"
          ? `Updated translation for ${targetLocale}.`
          : `Created draft translation for ${targetLocale}.`,
    };
  },

  cancelJob: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const jobId = String(form.get("jobId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "translation_jobs.cancel", {
      jobId,
    });
    if (!r.ok) return fail(400, { error: "cancel failed" });
    return { ok: true, message: "Job cancelled." };
  },

  publishCompleted: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const jobId = String(form.get("jobId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "translation_jobs.publish_completed", {
      jobId,
    });
    if (!r.ok) {
      const m =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "publish failed";
      return fail(400, { error: m });
    }
    const v = r.value as { publishedCount: number };
    return {
      ok: true,
      message: `Published ${v.publishedCount} translation${v.publishedCount === 1 ? "" : "s"}.`,
    };
  },
};
