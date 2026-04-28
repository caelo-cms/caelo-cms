// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface LayoutDetail {
  id: string;
  slug: string;
  displayName: string;
  html: string;
  css: string;
  blocks: { name: string; displayName: string; position: number }[];
}

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "layouts.get", {
    layoutId: params.id,
  });
  if (!res.ok) {
    error(404, "Layout not found");
  }
  const layout = (res.value as { layout: LayoutDetail | null }).layout;
  if (!layout) {
    error(404, "Layout not found");
  }
  return { layout };
};

export const actions: Actions = {
  update: async ({ params, request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const displayName = String(form.get("displayName") ?? "").trim();
    const html = String(form.get("html") ?? "");
    const css = String(form.get("css") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "layouts.update", {
      layoutId: params.id,
      displayName,
      html,
      css,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not update layout.";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Saved." };
  },

  setBlocks: async ({ params, request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    // The block editor serialises its state into a single JSON field so
    // the action handler doesn't have to parse N parallel form arrays.
    let blocks: unknown;
    try {
      blocks = JSON.parse(String(form.get("blocks") ?? "[]"));
    } catch {
      return fail(400, { error: "blocks payload is not valid JSON" });
    }
    if (!Array.isArray(blocks)) {
      return fail(400, { error: "blocks payload must be an array" });
    }
    const result = await execute(registry, adapter, locals.ctx, "layout_blocks.set", {
      layoutId: params.id,
      blocks,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not save blocks.";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Blocks saved." };
  },

  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const result = await execute(registry, adapter, locals.ctx, "layouts.delete", {
      layoutId: params.id,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "Could not delete layout.";
      return fail(400, { error: message });
    }
    redirect(303, "/security/layouts");
  },
};
