// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "snapshots.list", { limit: 100 });
  const snapshots = r.ok
    ? (
        r.value as {
          snapshots: {
            id: string;
            description: string;
            chatTaskId: string | null;
            revertOf: string | null;
            createdAt: string;
            moduleCount: number;
            templateCount: number;
            pageCount: number;
            pageLayoutCount: number;
          }[];
        }
      ).snapshots
    : [];
  return { snapshots };
};

export const actions: Actions = {
  revertSite: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const snapshotId = String(form.get("snapshotId") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_site", {
      snapshotId,
    });
    if (!result.ok) return fail(400, { error: "Could not revert site." });
    throw redirect(303, "/content/history");
  },
};
