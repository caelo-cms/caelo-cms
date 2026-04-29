// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
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
  return { redirects };
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
    if (!fromPath.startsWith("/") || !toPath.startsWith("/")) {
      return fail(400, { error: "fromPath and toPath must start with /" });
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
  delete: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const redirectId = String(form.get("redirectId") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "redirects.delete", { redirectId });
    if (!r.ok) return fail(400, { error: "delete failed" });
    return { ok: true, message: "Redirect removed." };
  },
};
