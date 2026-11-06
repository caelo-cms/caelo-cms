// SPDX-License-Identifier: MPL-2.0

import type { RedirectSyncTargetStatus } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { isExternalRedirectTarget, redirectTargetIssue } from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** An external redirect the AI proposed (#1358), as the queue shows it. */
interface Proposal {
  readonly id: string;
  readonly payload: {
    readonly redirects?: readonly { fromPath: string; url: string; statusCode: number }[];
  };
}

function messageOf(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "redirects.list", {});
  const redirects = r.ok
    ? (
        r.value as {
          redirects: { id: string; fromPath: string; toPath: string; statusCode: number }[];
        }
      ).redirects
    : [];
  // #1157 — saved redirects go live on the hosting right away; this is
  // where a push that failed (or is still pending) shows.
  const status = await execute(registry, adapter, locals.ctx, "redirects.sync_status", {});
  if (!status.ok) {
    throw new Error(`redirects.sync_status failed: ${JSON.stringify(status.error)}`);
  }
  const syncTargets = (status.value as { targets: RedirectSyncTargetStatus[] }).targets;
  const pending = await execute(registry, adapter, locals.ctx, "redirects.list_pending", {});
  if (!pending.ok) {
    throw new Error(`redirects.list_pending failed: ${JSON.stringify(pending.error)}`);
  }
  return {
    redirects,
    syncTargets,
    proposals: (pending.value as { proposals: Proposal[] }).proposals,
  };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const fromPath = String(form.get("fromPath") ?? "").trim();
    const toPath = String(form.get("toPath") ?? "").trim();
    const statusCodeRaw = Number(form.get("statusCode") ?? "301");
    const statusCode: 301 | 302 | 307 | 308 =
      statusCodeRaw === 302 || statusCodeRaw === 307 || statusCodeRaw === 308 ? statusCodeRaw : 301;
    if (!fromPath.startsWith("/")) {
      return fail(400, { error: "fromPath must start with /" });
    }
    // #1358 — a target on another domain: the same two ops as the AI's
    // proposal, approved in one go by whoever may approve it.
    if (isExternalRedirectTarget(toPath)) {
      requireApproverPermission(locals, registry, "redirects.execute_proposal");
      // No choice made: the op's default (temporary) for an address that
      // can change, not this form's permanent one for a page on the site.
      const chosen = form.get("statusCode") ? { statusCode } : {};
      const proposed = await execute(registry, adapter, locals.ctx, "redirects.propose_external", {
        redirects: [{ fromPath, url: toPath, ...chosen }],
      });
      if (!proposed.ok) return fail(400, { error: messageOf(proposed.error, "create failed") });
      const applied = await execute(registry, adapter, locals.ctx, "redirects.execute_proposal", {
        proposalId: (proposed.value as { proposalId: string }).proposalId,
      });
      if (!applied.ok) return fail(400, { error: messageOf(applied.error, "create failed") });
      return {
        ok: true,
        message: `Redirect ${fromPath} → ${toPath} created. ${(applied.value as { nextStep: string }).nextStep}`,
      };
    }
    // Same rule as the op's schema, surfaced here so the form shows the
    // specific reason (e.g. a pasted full URL) instead of a generic 400.
    const targetIssue = redirectTargetIssue(toPath);
    if (targetIssue) {
      return fail(400, { error: targetIssue });
    }
    const r = await execute(registry, adapter, locals.ctx, "redirects.create", {
      fromPath,
      toPath,
      statusCode,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "create failed";
      return fail(400, { error: message });
    }
    // #1447 — a page at this URL replaces the redirect once it is published
    // (it may still be a draft); say so now rather than at the next Stage.
    const onPages = await execute(registry, adapter, locals.ctx, "redirects.page_conflicts", {
      paths: [fromPath],
    });
    if (!onPages.ok) {
      throw new Error(`redirects.page_conflicts failed: ${JSON.stringify(onPages.error)}`);
    }
    const page = (onPages.value as { conflicts: { pageTitle: string }[] }).conflicts[0];
    return {
      ok: true,
      message: page
        ? `Redirect ${fromPath} → ${toPath} created, but the page "${page.pageTitle}" uses this URL. Once that page is published, visitors see it instead of the redirect. Remove the redirect or move the page.`
        : `Redirect ${fromPath} → ${toPath} created.`,
    };
  },
  approve: async ({ request, locals }) => {
    requireApproverPermission(locals, getQueryContext().registry, "redirects.execute_proposal");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "redirects.execute_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "approve failed") });
    return { ok: true, message: (r.value as { nextStep: string }).nextStep };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const reason = String(form.get("reason") ?? "").trim();
    const r = await execute(registry, adapter, locals.ctx, "redirects.reject_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "reject failed") });
    return { ok: true, message: "Proposal rejected." };
  },
  sync: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const targetId = String(form.get("targetId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) return fail(400, { error: "targetId missing" });
    const r = await execute(registry, adapter, locals.ctx, "redirects.sync_provider", {
      trigger: "manual",
      targetIds: [targetId],
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "sync failed";
      return fail(500, { error: message });
    }
    const failed = (
      r.value as { targets: { targetName: string; status: string; error: string | null }[] }
    ).targets.filter((t) => t.status === "failed");
    if (failed.length > 0) {
      return fail(502, {
        error: `Still not live: ${failed.map((t) => `${t.targetName}: ${t.error}`).join("; ")}`,
      });
    }
    return { ok: true, message: "Redirects are live on your hosting." };
  },
  delete: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const redirectId = String(form.get("redirectId") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "redirects.delete", { redirectId });
    if (!r.ok) {
      // A failed push to the hosting says the delete is saved (#1157).
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "delete failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Redirect removed." };
  },
};
