// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ params, locals }) => {
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "snapshots.get_with_entities", {
        snapshotId: params.snapshotId,
    });
    if (!r.ok)
        throw error(404, "Snapshot not found");
    return r.value;
};
export const actions = {
    revertModule: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const moduleId = String(form.get("moduleId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_module", {
            moduleId,
            snapshotId: params.snapshotId,
        });
        if (!result.ok)
            return fail(400, { error: "Could not revert module." });
        return { ok: "Module reverted." };
    },
    revertTemplate: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const templateId = String(form.get("templateId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_template", {
            templateId,
            snapshotId: params.snapshotId,
        });
        if (!result.ok)
            return fail(400, { error: "Could not revert template." });
        return { ok: "Template reverted." };
    },
    revertPage: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const pageId = String(form.get("pageId") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_page", {
            pageId,
            snapshotId: params.snapshotId,
        });
        if (!result.ok)
            return fail(400, { error: "Could not revert page." });
        return { ok: "Page reverted." };
    },
    revertSite: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const result = await execute(registry, adapter, locals.ctx, "snapshots.revert_site", {
            snapshotId: params.snapshotId,
        });
        if (!result.ok)
            return fail(400, { error: "Could not revert site." });
        throw redirect(303, "/content/history");
    },
};
