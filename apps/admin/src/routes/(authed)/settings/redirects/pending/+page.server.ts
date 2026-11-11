// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — the queue URL the AI's Go live now card names, in the canonical
 * proposal shape (`/settings/<domain>/pending`, proposal-parser.ts). The
 * card posts Approve / Reject here; both are Settings → Redirects' own
 * decisions. A visit lands on Settings → Redirects, which lists the queue.
 */

import { redirect } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { approveRedirectProposal, rejectRedirectProposal } from "#lib/server/redirect-proposals.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  // The same guard as Settings → Redirects, where the visit lands.
  requirePermission(locals, "content.read");
  throw redirect(303, "/settings/redirects");
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    const form = await request.formData();
    return approveRedirectProposal(locals, form, String(form.get("proposalId") ?? ""));
  },
  reject: async ({ request, locals }) => {
    const form = await request.formData();
    return rejectRedirectProposal(locals, form, String(form.get("proposalId") ?? ""));
  },
};
