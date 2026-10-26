// SPDX-License-Identifier: MPL-2.0

import type { RedirectSyncTargetStatus } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { redirectTargetIssue } from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

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
  return { redirects, syncTargets };
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
    return { ok: true, message: `Redirect ${fromPath} → ${toPath} created.` };
  },
  sync: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const r = await execute(registry, adapter, locals.ctx, "redirects.sync_provider", {
      trigger: "manual",
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
