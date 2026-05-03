// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const { adapter, registry } = getQueryContext();
  const [pageResult, modulesResult, templatesResult] = await Promise.all([
    execute(registry, adapter, locals.ctx, "pages.get_with_modules", { pageId: params.id }),
    execute(registry, adapter, locals.ctx, "modules.list", {}),
    execute(registry, adapter, locals.ctx, "templates.list", {}),
  ]);
  if (!pageResult.ok) throw error(404, "Page not found");
  return {
    page: (pageResult.value as { page: unknown }).page,
    allModules: modulesResult.ok
      ? (
          modulesResult.value as {
            modules: { id: string; slug: string; displayName: string }[];
          }
        ).modules
      : [],
    allTemplates: templatesResult.ok
      ? (
          templatesResult.value as {
            templates: {
              id: string;
              slug: string;
              displayName: string;
              blocks: { name: string; displayName: string }[];
            }[];
          }
        ).templates
      : [],
  };
};

interface BlockSubmission {
  blockName: string;
  moduleIds: string[];
}

function parseBlocks(form: FormData): BlockSubmission[] {
  // Form fields: blocks[BLOCK_NAME] = "<id>,<id>,…" (one hidden input per block)
  const out: BlockSubmission[] = [];
  for (const [key, value] of form.entries()) {
    const m = /^blocks\[(.+)\]$/.exec(key);
    if (!m || !m[1]) continue;
    const moduleIds = String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ blockName: m[1], moduleIds });
  }
  return out;
}

export const actions: Actions = {
  update: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const expectedVersionRaw = form.get("expectedVersion");
    const expectedVersion =
      expectedVersionRaw === null ? undefined : Number.parseInt(String(expectedVersionRaw), 10);

    const result = await execute(registry, adapter, locals.ctx, "pages.update", {
      pageId: params.id,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      title: String(form.get("title") ?? ""),
      status: String(form.get("status") ?? "draft") === "published" ? "published" : "draft",
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "";
      if (message.startsWith("conflict")) {
        return fail(409, { error: `${message} — reload the page and try again.` });
      }
      return fail(400, { error: "Could not update page metadata." });
    }
    return { ok: true };
  },

  setModules: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const expectedVersionRaw = form.get("expectedVersion");
    const expectedVersion =
      expectedVersionRaw === null ? undefined : Number.parseInt(String(expectedVersionRaw), 10);

    const blocks = parseBlocks(form);
    const result = await execute(registry, adapter, locals.ctx, "pages.set_modules", {
      pageId: params.id,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      blocks,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "";
      if (message.startsWith("conflict")) {
        return fail(409, { error: `${message} — reload the page and try again.` });
      }
      return fail(400, { error: "Could not save page layout." });
    }
    return { ok: true };
  },

  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const result = await execute(registry, adapter, locals.ctx, "pages.delete", {
      pageId: params.id,
    });
    if (!result.ok) return fail(400, { error: "Could not delete page." });
    throw redirect(303, "/content/pages");
  },
};
