// SPDX-License-Identifier: MPL-2.0
/**
 * P12 review-pass — Forms plugin admin UI.
 * Owner-only inbox for visitor form submissions; mark-read + archive
 * actions dispatch through the plugin host.
 */
import { runPluginOperation } from "@caelo-cms/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
export const load = async ({ locals, url }) => {
    requirePermission(locals, "settings.write");
    const status = url.searchParams.get("status") ?? "";
    const args = { limit: 200 };
    if (status === "new" || status === "read" || status === "archived" || status === "spam") {
        args.status = status;
    }
    const r = await runPluginOperation({
        pluginSlug: "forms",
        operationName: "list_submissions",
        args,
    });
    const submissions = r.ok ? (r.value.submissions ?? []) : [];
    return {
        submissions,
        activeStatus: status || "all",
        error: r.ok ? null : r.error.message,
    };
};
export const actions = {
    markRead: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const id = form.get("submissionId");
        if (typeof id !== "string")
            return fail(400, { error: "submissionId required" });
        const r = await runPluginOperation({
            pluginSlug: "forms",
            operationName: "mark_read",
            args: { submissionId: id },
        });
        if (!r.ok)
            return fail(400, { error: r.error.message });
        return { ok: true, message: "Marked as read." };
    },
    archive: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const id = form.get("submissionId");
        if (typeof id !== "string")
            return fail(400, { error: "submissionId required" });
        const r = await runPluginOperation({
            pluginSlug: "forms",
            operationName: "archive",
            args: { submissionId: id },
        });
        if (!r.ok)
            return fail(400, { error: r.error.message });
        return { ok: true, message: "Archived." };
    },
};
