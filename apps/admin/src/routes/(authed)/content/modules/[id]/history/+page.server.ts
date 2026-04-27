// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const { adapter, registry } = getQueryContext();
  const [moduleResult, snapshotsResult] = await Promise.all([
    execute(registry, adapter, locals.ctx, "modules.get", { moduleId: params.id }),
    execute(registry, adapter, locals.ctx, "snapshots.list", {
      limit: 100,
      forModuleId: params.id,
    }),
  ]);
  const module = moduleResult.ok
    ? (moduleResult.value as { module: { slug: string; displayName: string } }).module
    : null;
  const snapshots = snapshotsResult.ok
    ? (
        snapshotsResult.value as {
          snapshots: {
            id: string;
            description: string;
            revertOf: string | null;
            createdAt: string;
          }[];
        }
      ).snapshots
    : [];
  return { moduleId: params.id, module, snapshots };
};

export const actions: Actions = {
  revert: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const snapshotId = String(form.get("snapshotId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_module", {
      moduleId: params.id,
      snapshotId,
    });
    if (!result.ok) return fail(400, { error: "Could not revert module to that snapshot." });
    throw redirect(303, `/content/modules/${params.id}`);
  },
};
