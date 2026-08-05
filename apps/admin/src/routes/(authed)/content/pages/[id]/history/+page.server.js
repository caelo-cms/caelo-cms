// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ params, locals }) => {
    const { adapter, registry } = getQueryContext();
    const [pageResult, snapshotsResult] = await Promise.all([
        execute(registry, adapter, locals.ctx, "pages.get", { pageId: params.id }),
        execute(registry, adapter, locals.ctx, "snapshots.list", {
            limit: 100,
            forPageId: params.id,
        }),
    ]);
    const pageRow = pageResult.ok
        ? pageResult.value.page
        : null;
    const snapshots = snapshotsResult.ok
        ? snapshotsResult.value.snapshots
        : [];
    return { pageId: params.id, page: pageRow, snapshots };
};
export const actions = {
    revert: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const snapshotId = String(form.get("snapshotId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_page", {
            pageId: params.id,
            snapshotId,
        });
        if (!result.ok)
            return fail(400, { error: "Could not revert page to that snapshot." });
        throw redirect(303, `/content/pages/${params.id}`);
    },
};
