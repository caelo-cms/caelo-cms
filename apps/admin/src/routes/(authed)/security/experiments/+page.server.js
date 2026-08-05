// SPDX-License-Identifier: MPL-2.0
/**
 * P13 — A/B experiments list + create/activate.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "experiments.list", {});
    const experiments = r.ok ? r.value.experiments : [];
    return { experiments, error: r.ok ? null : r.error.kind };
};
export const actions = {
    create: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const slug = form.get("slug") ?? "";
        const pageId = form.get("pageId") ?? "";
        const variantsRaw = form.get("variants") ?? "";
        let variants;
        try {
            variants = JSON.parse(variantsRaw);
        }
        catch {
            return fail(400, { error: "variants must be JSON" });
        }
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "experiments.create", {
            slug,
            pageId,
            variants,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return { ok: true, message: "Experiment drafted. Activate when ready." };
    },
    activate: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const id = form.get("experimentId");
        if (typeof id !== "string")
            return fail(400, { error: "experimentId required" });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "experiments.activate", {
            experimentId: id,
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return { ok: true, message: "Experiment activated; visitors now split." };
    },
    complete: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        const id = form.get("experimentId");
        const winner = form.get("winningVariant") ?? "";
        if (typeof id !== "string")
            return fail(400, { error: "experimentId required" });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "experiments.complete", {
            experimentId: id,
            ...(winner ? { winningVariant: winner } : {}),
        });
        if (!r.ok)
            return fail(400, { error: r.error.kind });
        return { ok: true, message: "Experiment completed." };
    },
};
