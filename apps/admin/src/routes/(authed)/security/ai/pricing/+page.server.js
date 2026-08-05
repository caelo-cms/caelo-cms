// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.read");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "ai_pricing.list", {});
    const rows = r.ok ? (r.value.rows ?? []) : [];
    return { rows };
};
export const actions = {
    set: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const provider = String(form.get("provider") ?? "").trim();
        const model = String(form.get("model") ?? "").trim();
        const operationType = String(form.get("operationType") ?? "text");
        const inputMicrocents = Number.parseInt(String(form.get("inputMicrocents") ?? "0"), 10);
        const outputRaw = String(form.get("outputMicrocents") ?? "");
        const cachedRaw = String(form.get("cachedMicrocents") ?? "");
        const outputMicrocents = outputRaw === "" ? null : Number.parseInt(outputRaw, 10);
        const cachedMicrocents = cachedRaw === "" ? null : Number.parseInt(cachedRaw, 10);
        if (!provider || !model)
            return fail(400, { error: "provider and model are required" });
        if (!Number.isFinite(inputMicrocents) || inputMicrocents < 0) {
            return fail(400, { error: "inputMicrocents must be a non-negative integer" });
        }
        const r = await execute(registry, adapter, locals.ctx, "ai_pricing.set", {
            provider,
            model,
            operationType,
            inputMicrocents,
            outputMicrocents,
            cachedMicrocents,
        });
        if (!r.ok)
            return fail(400, { error: "could not save pricing row" });
        return { ok: true, key: `${provider}/${model}/${operationType}` };
    },
};
