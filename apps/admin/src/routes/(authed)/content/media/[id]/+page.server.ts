// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "media.get", { assetId: params.id });
  if (!res.ok) throw error(404, "asset not found");
  const asset = (res.value as { asset: unknown }).asset;
  if (!asset) throw error(404, "asset not found");

  const usages = await execute(registry, adapter, locals.ctx, "media.list_usages", {
    assetId: params.id,
  });
  const referencingModules = usages.ok
    ? (
        usages.value as {
          modules: { id: string; slug: string; displayName: string }[];
        }
      ).modules
    : [];

  return { asset, referencingModules };
};

export const actions: Actions = {
  updateAlt: async ({ request, locals, params }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const alt = String(form.get("alt") ?? "");
    const res = await execute(registry, adapter, locals.ctx, "media.update_alt", {
      assetId: params.id,
      alt,
    });
    if (!res.ok) {
      const message =
        typeof res.error === "object" && res.error && "message" in res.error
          ? String((res.error as { message: unknown }).message)
          : "alt update failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Alt text saved." };
  },
  delete: async ({ request, locals, params }) => {
    // Owner-proxy via roles.manage — same pattern /security/layouts uses
    // until the catalogue grows an explicit `media.delete` permission.
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const force = form.get("force") === "true";
    const res = await execute(registry, adapter, locals.ctx, "media.delete", {
      assetId: params.id,
      force,
    });
    if (!res.ok) {
      const message =
        typeof res.error === "object" && res.error && "message" in res.error
          ? String((res.error as { message: unknown }).message)
          : "delete failed";
      return fail(400, { error: message });
    }
    throw redirect(303, "/content/media");
  },
};
