// SPDX-License-Identifier: MPL-2.0
/**
 * "Detected bugs" — operator-facing view of `ai_bug_reports`, the defects
 * and suggestions the AI filed while working (see `ops/ai/bug-reports.ts`), plus the
 * Owner's choice whether they go to the Caelo team (epic #901,
 * `ops/ai/bug-forwarding.ts`). The Markdown / JSON export stays for
 * installs that keep forwarding off.
 */
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.read");
    const { adapter, registry } = getQueryContext();
    const [r, f] = await Promise.all([
        execute(registry, adapter, locals.ctx, "ai_bug_reports.list", { limit: 200 }),
        execute(registry, adapter, locals.ctx, "bug_forwarding.get", {}),
    ]);
    if (!f.ok)
        throw new Error(`bug_forwarding.get: ${JSON.stringify(f.error)}`);
    const reports = r.ok ? r.value.reports : [];
    return { reports, forwarding: f.value };
};
export const actions = {
    setForwarding: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const enabled = form.get("enabled") === "1";
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "bug_forwarding.set", { enabled });
        if (!r.ok) {
            return fail(400, {
                error: `Could not save the setting: ${opErrorMessage(r.error, "the server refused the change")}`,
            });
        }
        return {
            ok: enabled
                ? "Detected bugs are now sent to the Caelo team."
                : "Detected bugs stay on this site.",
        };
    },
    queueUnsent: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "bug_forwarding.queue_unsent", {});
        if (!r.ok) {
            return fail(400, {
                error: opErrorMessage(r.error, "Turn on sending to the Caelo team first."),
            });
        }
        const { queued } = r.value;
        return {
            ok: queued === 1
                ? "1 report will be sent to the Caelo team."
                : `${queued} reports will be sent to the Caelo team.`,
        };
    },
};
