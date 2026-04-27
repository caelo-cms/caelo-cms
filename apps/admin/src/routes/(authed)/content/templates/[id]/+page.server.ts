// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "templates.get", {
    templateId: params.id,
  });
  if (!result.ok) throw error(404, "Template not found");
  return { template: (result.value as { template: unknown }).template };
};

interface BlockInput {
  name: string;
  displayName: string;
  position: number;
}

function parseBlocks(form: FormData): BlockInput[] {
  // Form fields: blockName.0, blockDisplay.0, blockName.1, …
  const out: BlockInput[] = [];
  let i = 0;
  while (form.has(`blockName.${i}`)) {
    const name = String(form.get(`blockName.${i}`) ?? "").trim();
    const displayName = String(form.get(`blockDisplay.${i}`) ?? "").trim();
    if (name.length > 0) out.push({ name, displayName: displayName || name, position: i });
    i += 1;
  }
  return out;
}

export const actions: Actions = {
  update: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const result = await execute(registry, adapter, locals.ctx, "templates.update", {
      templateId: params.id,
      displayName: String(form.get("displayName") ?? ""),
      html: String(form.get("html") ?? ""),
      css: String(form.get("css") ?? ""),
    });
    if (!result.ok) return fail(400, { error: "Could not update template." });
    return { ok: true };
  },

  setBlocks: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const blocks = parseBlocks(form);
    const result = await execute(registry, adapter, locals.ctx, "template_blocks.set", {
      templateId: params.id,
      blocks,
    });
    if (!result.ok) return fail(400, { error: "Could not save blocks." });
    return { ok: true };
  },

  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const result = await execute(registry, adapter, locals.ctx, "templates.delete", {
      templateId: params.id,
    });
    if (!result.ok) return fail(400, { error: "Could not delete template (still in use?)." });
    throw redirect(303, "/content/templates");
  },
};
