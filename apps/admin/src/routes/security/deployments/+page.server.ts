// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "ops.view");
  const { adapter, registry } = getQueryContext();
  const [targets, runs] = await Promise.all([
    execute(registry, adapter, locals.ctx, "deploy.list_targets", {}),
    execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 25 }),
  ]);
  return {
    targets: targets.ok
      ? (
          targets.value as {
            targets: {
              id: string;
              name: string;
              env: string;
              outDir: string;
              robotsDefault: string;
              isDefault: boolean;
            }[];
          }
        ).targets
      : [],
    runs: runs.ok
      ? (
          runs.value as {
            runs: {
              id: string;
              targetName: string;
              env: string;
              status: string;
              startedAt: string;
              finishedAt: string | null;
              pageCount: number | null;
              fileCount: number | null;
              errorMessage: string | null;
            }[];
          }
        ).runs
      : [],
  };
};

export const actions: Actions = {
  trigger: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const targetName = String(form.get("targetName") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "deploy.trigger", { targetName });
    if (!result.ok) return fail(500, { error: `Deploy failed for ${targetName}.` });
    throw redirect(303, "/security/deployments");
  },
  promote: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    requirePermission(locals, "ops.view");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const fromTarget = String(form.get("fromTarget") ?? "");
    const toTarget = String(form.get("toTarget") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "deploy.promote", {
      fromTarget,
      toTarget,
    });
    if (!result.ok) return fail(500, { error: `Promote ${fromTarget} → ${toTarget} failed.` });
    throw redirect(303, "/security/deployments");
  },
};
