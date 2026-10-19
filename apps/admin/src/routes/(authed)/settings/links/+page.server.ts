// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 rollout E — the Owner's view of the internal-link migration:
 * the latest run's report (links converted per place, links that could
 * not be converted and where they are), a dry run / re-run, and revert.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface RunSummary {
  runId: string;
  mode: "dry_run" | "apply" | "import";
  trigger: "boot" | "manual" | "import";
  importRunId: string | null;
  createdAt: string;
  counts: Record<string, number>;
  entitiesChanged: number;
  unresolvedCount: number;
  revertedAt: string | null;
}

interface Unresolved {
  surface: string;
  entityKind: string;
  entityId: string;
  branchId: string | null;
  label: string;
  where: string;
  value: string;
  kind: string;
}

function messageOf(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const runId = url.searchParams.get("run") ?? undefined;
  const r = await execute(registry, adapter, locals.ctx, "links.get_migration_report", {
    ...(runId ? { runId } : {}),
    limit: 500,
  });
  if (!r.ok) {
    return {
      run: null,
      unresolved: [],
      unresolvedTotal: 0,
      recentRuns: [],
      error: messageOf(r.error, "report failed"),
    };
  }
  const v = r.value as {
    run: RunSummary | null;
    unresolved: Unresolved[];
    unresolvedTotal: number;
    recentRuns: RunSummary[];
  };
  return { ...v, error: null as string | null };
};

export const actions: Actions = {
  run: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const dryRun = form.get("dryRun") === "true";
    const r = await execute(registry, adapter, locals.ctx, "links.migrate_to_references", {
      dryRun,
      trigger: "manual",
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "migration failed") });
    const v = r.value as { run: RunSummary | null };
    const converted = Object.values(v.run?.counts ?? {}).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      message: dryRun
        ? `Dry run: ${converted} link(s) would be converted, ${v.run?.unresolvedCount ?? 0} could not be.`
        : `${converted} link(s) converted, ${v.run?.unresolvedCount ?? 0} could not be.`,
    };
  },
  revert: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const runId = String(form.get("runId") ?? "");
    const skipConflicts = form.get("skipConflicts") === "true";
    const r = await execute(registry, adapter, locals.ctx, "links.revert_migration", {
      runId,
      skipConflicts,
    });
    if (!r.ok)
      return fail(400, { error: messageOf(r.error, "revert failed"), conflict: true, runId });
    const v = r.value as { restored: number; skippedConflicts: number };
    return {
      ok: true,
      message: `Reverted: ${v.restored} part(s) restored${v.skippedConflicts > 0 ? `, ${v.skippedConflicts} edited part(s) kept` : ""}.`,
    };
  },
};
