// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requirePermission(locals, "roles.manage");
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const slug = String(form.get("slug") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const html = String(form.get("html") ?? "");
    const css = String(form.get("css") ?? "");
    // Block names + display names + positions all arrive as parallel
    // arrays from the repeatable form rows.
    const blockNames = form
      .getAll("blockName")
      .map((v) => String(v).trim())
      .filter(Boolean);
    const blockDisplayNames = form.getAll("blockDisplayName").map((v) => String(v).trim());
    const blockPositions = form.getAll("blockPosition").map((v) => Number.parseInt(String(v), 10));

    const blocks = blockNames.map((name, i) => ({
      name,
      displayName: blockDisplayNames[i] || name,
      position: Number.isFinite(blockPositions[i]) ? blockPositions[i]! : i,
    }));

    if (blocks.length === 0) {
      return fail(400, {
        error: "At least one block is required (the `content` block is mandatory).",
      });
    }

    const result = await execute(registry, adapter, locals.ctx, "layouts.create", {
      slug,
      displayName,
      html,
      css,
      blocks,
    });
    if (!result.ok) {
      const message =
        (result.error as { message?: string; issues?: unknown[] }).message ??
        "Could not create layout.";
      return fail(400, { error: message });
    }
    redirect(303, "/security/layouts");
  },
};
