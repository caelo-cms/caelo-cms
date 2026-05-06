// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.25 — Owner queue for AI-proposed email_config changes.
 *
 * Approve action collects per-transport secret(s) inline via the form
 * (smtpPassword / resendApiKey / sesAccessKeyId+sesSecretAccessKey).
 * The proposal payload never contained a secret; the Owner-supplied
 * field is merged in at execute_proposal time.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Proposal {
  id: string;
  proposedBy: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: "pending" | "applied" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "email_config.list_pending", {});
  const proposals = r.ok ? (r.value as { proposals: Proposal[] }).proposals : [];
  return { proposals };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    // Collect Owner-supplied secrets for the proposed transport. Each
    // is optional; the underlying handler validates that the
    // proposed transport's required secrets are actually present.
    const secrets: Record<string, string> = {};
    for (const k of [
      "smtpPassword",
      "resendApiKey",
      "sesAccessKeyId",
      "sesSecretAccessKey",
    ] as const) {
      const v = form.get(k);
      if (typeof v === "string" && v.length > 0) secrets[k] = v;
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "email_config.execute_proposal", {
      proposalId,
      ...secrets,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "approve failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Email config applied." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const proposalId = String(form.get("proposalId") ?? "");
    const reason = form.get("reason") ? String(form.get("reason")) : undefined;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "email_config.reject_proposal", {
      proposalId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "reject failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Proposal rejected." };
  },
};
