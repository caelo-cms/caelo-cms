// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const skillsR = await execute(registry, adapter, locals.ctx, "skills.list", { status: "any" });
    const proposalsR = await execute(registry, adapter, locals.ctx, "skills.list_proposals", {
        status: "pending",
    });
    const skills = skillsR.ok ? skillsR.value.skills : [];
    const proposals = proposalsR.ok
        ? proposalsR.value.proposals
        : [];
    return { skills, proposals };
};
export const actions = {
    setStatus: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const slug = String(form.get("slug") ?? "");
        const status = String(form.get("status") ?? "");
        if (!slug || !["awaiting_activation", "active", "archived"].includes(status)) {
            return fail(400, { error: "slug + valid status required" });
        }
        const { adapter, registry } = getQueryContext();
        // Fetch the existing row so we keep its body / hints.
        const get = await execute(registry, adapter, locals.ctx, "skills.get", { slug });
        if (!get.ok)
            return fail(400, { error: "lookup failed" });
        const skill = get.value.skill;
        if (!skill)
            return fail(404, { error: "skill not found" });
        const r = await execute(registry, adapter, locals.ctx, "skills.set", {
            slug: skill.slug,
            displayName: skill.displayName,
            description: skill.description,
            body: skill.body,
            allowlistedTools: skill.allowlistedTools,
            hints: skill.hints,
            status: status,
        });
        if (!r.ok)
            return fail(400, { error: "update failed" });
        return { ok: true, message: `Skill '${slug}' is now ${status}.` };
    },
    reviewProposal: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const proposalId = String(form.get("proposalId") ?? "");
        const decision = String(form.get("decision") ?? "");
        if (!proposalId || (decision !== "accept" && decision !== "reject")) {
            return fail(400, { error: "proposalId + accept/reject required" });
        }
        const note = form.get("note") ? String(form.get("note")) : undefined;
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "skills.review_proposal", {
            proposalId,
            decision: decision,
            decisionNote: note,
        });
        if (!r.ok)
            return fail(400, { error: "review failed" });
        const v = r.value;
        return {
            ok: true,
            message: decision === "accept"
                ? `Accepted. Skill landed at status='awaiting_activation'${v.resultingSkillId ? ` (id ${v.resultingSkillId.slice(0, 8)})` : ""}. Activate it from the skills list.`
                : "Proposal rejected.",
        };
    },
};
