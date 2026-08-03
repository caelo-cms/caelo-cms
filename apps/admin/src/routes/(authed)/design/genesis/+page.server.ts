// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — /design/genesis: side-by-side comparison of design
 * drafts; issue #375 generalises it from "the Genesis drafts" to any
 * variant set (page/module-scope growth-time variants included).
 *
 * Site-scope drafts are complete standalone documents rendered via
 * iframe srcdoc (sandbox="" — no scripts, no same-origin; they load no
 * admin subresources by authoring rule). Page/module-scope fragments
 * render via /design/drafts/[id]/preview instead, where the server
 * composes them into the site's REAL theme shell — their iframes use
 * sandbox="allow-same-origin" (no allow-scripts) so auth-gated font +
 * media subresources load; see the route for the security stance.
 *
 * Permission is content.write (was roles.manage pre-#375): growth-time
 * variants are an editor surface — the same operator who reviews them
 * inline in the chat must be able to open the full-size comparison.
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
  scope: "site" | "page" | "module";
  format: "document" | "fragment";
  variantSetId: string;
  createdAt: string;
  /** Only present for documents (srcdoc render); fragments render via
   *  the /design/drafts/[id]/preview route. */
  html?: string;
}

export interface VariantSetView {
  variantSetId: string;
  scope: "page" | "module";
  drafts: GenesisDraftView[];
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();
  // Two listings on purpose (PR-378 review): only site documents need
  // their HTML here (srcdoc render); fragments render via the preview
  // route, so pulling their bodies would grow with every variant round.
  const [siteRes, fragRes] = await Promise.all([
    execute(registry, adapter, locals.ctx, "genesis.list_drafts", {
      scope: "site",
      includeHtml: true,
    }),
    execute(registry, adapter, locals.ctx, "genesis.list_drafts", { includeHtml: false }),
  ]);
  const strip = (d: GenesisDraftView, withHtml: boolean): GenesisDraftView => ({
    id: d.id,
    direction: d.direction,
    rationale: d.rationale,
    status: d.status,
    scope: d.scope,
    format: d.format,
    variantSetId: d.variantSetId,
    createdAt: d.createdAt,
    ...(withHtml && d.html !== undefined ? { html: d.html } : {}),
  });
  const siteDrafts = (
    siteRes.ok ? (siteRes.value as { drafts: GenesisDraftView[] }).drafts : []
  ).map((d) => strip(d, true));
  const fragments = (
    fragRes.ok ? (fragRes.value as { drafts: GenesisDraftView[] }).drafts : []
  ).map((d) => strip(d, false));
  const sets = new Map<string, VariantSetView>();
  for (const d of fragments) {
    if (d.scope === "site") continue;
    const existing = sets.get(d.variantSetId);
    if (existing) existing.drafts.push(d);
    else sets.set(d.variantSetId, { variantSetId: d.variantSetId, scope: d.scope, drafts: [d] });
  }
  // Newest round first — the comparison the operator was just sent to.
  const variantSets = [...sets.values()].sort((a, b) => {
    const at = a.drafts[0]?.createdAt ?? "";
    const bt = b.drafts[0]?.createdAt ?? "";
    return bt.localeCompare(at);
  });
  return { siteDrafts, variantSets };
};

export const actions: Actions = {
  select: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
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
