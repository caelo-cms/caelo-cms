// SPDX-License-Identifier: MPL-2.0
/**
 * P14 — per-run review surface. Lists extracted pages with Accept /
 * (future) Reject actions, and a Cleanup button.
 */
import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
export const load = async ({ params, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.get", {
        runId: params.runId,
    });
    if (!r.ok)
        throw error(404, "Run not found");
    const v = r.value;
    if (!v.run)
        throw error(404, "Run not found");
    // #1276 — the Accept action names the new page's type (its default
    // template is used; the Owner can swap later via change_template).
    const types = await execute(registry, adapter, locals.ctx, "page_types.list", {});
    const pageTypes = types.ok
        ? types.value.pageTypes.map((t) => ({
            slug: t.slug,
            name: t.name,
        }))
        : [];
    return { run: v.run, pages: v.pages, pageTypes };
};
export const actions = {
    accept: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const importPageId = form.get("importPageId");
        const pageType = form.get("pageType");
        if (typeof importPageId !== "string" || typeof pageType !== "string" || pageType === "") {
            return fail(400, { error: "Choose the page type of the imported page." });
        }
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "imports.accept_page", {
            importPageId,
            pageType,
        });
        if (!r.ok) {
            const message = r.error.message;
            return fail(400, { error: message ?? r.error.kind });
        }
        const v = r.value;
        return { ok: true, message: `Promoted to draft page ${v.pageId.slice(0, 8)}.` };
    },
    cleanup: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const runId = form.get("runId");
        if (typeof runId !== "string")
            return fail(400, { error: "runId required" });
        const { adapter, registry } = getQueryContext();
        // issue #198 — the op returns the screenshot keys of exactly the rows
        // it dropped (un-accepted pages only); delete those objects best-effort
        // after the commit. The DB tx stays free of storage IO; a failed object
        // delete leaves a harmless orphan, never a broken run. Accepted pages
        // keep their screenshots — the per-page import reads still use them.
        const r = await execute(registry, adapter, locals.ctx, "imports.cleanup_run", {
            runId,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        const { droppedScreenshotKeys } = r.value;
        const { getMediaStorage } = await import("@caelo-cms/admin-core");
        const storage = getMediaStorage();
        await Promise.all(droppedScreenshotKeys.map((k) => storage.delete(k).catch(() => undefined)));
        return { ok: true, message: "Run cleaned up. Accepted pages stay; un-accepted rows dropped." };
    },
};
