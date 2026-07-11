// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — /design/genesis: side-by-side comparison of the Site
 * Genesis drafts (complete freeform single-file HTML pages, one per
 * design direction). The operator previews each in a sandboxed iframe
 * and clicks Select — the chosen draft becomes the design source the
 * compiler (#164) derives the CMS structure from.
 *
 * Permission mirrors /design/themes (`roles.manage`): Genesis runs at
 * install time when the Owner is the only user; broadening to editors
 * can follow operator feedback.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export interface GenesisDraftView {
  id: string;
  direction: string;
  rationale: string;
  status: "candidate" | "selected" | "discarded";
  createdAt: string;
  html: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "genesis.list_drafts", {
    includeHtml: true,
  });
  const drafts = r.ok ? (r.value as { drafts: GenesisDraftView[] }).drafts : [];
  return { drafts };
};

export const actions: Actions = {
  select: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    assertCsrfToken(form, locals);
    const draftId = String(form.get("draftId") ?? "");
    if (draftId === "") return fail(400, { message: "draftId missing" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "genesis.select_draft", { draftId });
    if (!r.ok) {
      return fail(400, { message: `select failed: ${JSON.stringify(r.error)}` });
    }
    return { selected: draftId };
  },
};
