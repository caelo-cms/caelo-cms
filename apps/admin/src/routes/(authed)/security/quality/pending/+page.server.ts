// SPDX-License-Identifier: MPL-2.0

/**
 * #553 — queue for quality decisions proposed OUTSIDE a chat turn (the
 * Power-MCP surface, which has no in-chat approval card, falls back to
 * propose-only). In a chat the same decisions are approved on the inline
 * card; this page is where the rest land.
 *
 * Any editor may accept findings (content.write, #553 §5); publishing over a
 * failed check also needs deploy.trigger, like Publish live itself.
 */

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  kind: "accept" | "publish_anyway";
  proposedBy: string;
  auditRunId: string | null;
  preview: Record<string, unknown>;
  createdAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "quality_audits.list_pending", {});
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals, loadError: r.ok ? null : describeError(r.error) };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const { adapter, registry } = getQueryContext();
    // The permission follows the STORED kind, never a form field: a
    // publish_anyway proposal needs deploy.trigger like Publish live.
    // (quality_audits.execute_proposal re-checks it for the chat path.)
    const listed = await execute(registry, adapter, locals.ctx, "quality_audits.list_pending", {
      limit: 200,
    });
    if (!listed.ok) return fail(400, { error: describeError(listed.error) });
    const proposal = (listed.value as { proposals: Proposal[] }).proposals.find(
      (p) => p.id === proposalId,
    );
    if (!proposal) return fail(404, { error: "proposal not found or no longer pending" });
    if (proposal.kind === "publish_anyway") requirePermission(locals, "deploy.trigger");
    const r = await execute(registry, adapter, locals.ctx, "quality_audits.execute_proposal", {
      proposalId,
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    const v = r.value as { kind: string; accepted?: number };
    return {
      ok: true,
      message:
        v.kind === "accept"
          ? `Accepted ${v.accepted ?? 0} quality finding(s).`
          : "Published live over the failed quality check.",
    };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "quality_audits.reject_proposal", {
      proposalId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return { ok: true, message: "Proposal rejected." };
  },
};
