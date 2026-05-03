// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

type TokenRow = {
  id: string;
  actorId: string;
  displayName: string;
  aiCostCapMicrocents: number | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  expiresAt: string;
};

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.list", {});
  const tokens: TokenRow[] = r.ok ? ((r.value as { tokens: TokenRow[] }).tokens ?? []) : [];
  // The admin install's public URL — surfaces in the `claude mcp add`
  // snippet the create-flow shows. Best-effort: derive from request URL.
  const adminUrl = `${url.protocol}//${url.host}`;
  return { tokens, adminUrl };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const displayName = String(form.get("displayName") ?? "").trim();
    const capRaw = String(form.get("aiCostCapMicrocents") ?? "");
    if (!displayName) return fail(400, { error: "displayName required" });
    const cap = capRaw === "" ? null : Number.parseInt(capRaw, 10);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
      return fail(400, { error: "aiCostCapMicrocents must be a non-negative integer" });
    }
    const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.create", {
      displayName,
      aiCostCapMicrocents: cap,
    });
    if (!r.ok) return fail(400, { error: "could not create token" });
    const v = r.value as { id: string; plaintextToken: string };
    // Returned ONCE — the page renders it as a save-now banner, then the
    // user copies + pastes into their `claude mcp add` invocation.
    return { ok: true, id: v.id, plaintextToken: v.plaintextToken, displayName };
  },
  revoke: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.revoke", { id });
    if (!r.ok) return fail(400, { error: "could not revoke token" });
    return { ok: true, revoked: id };
  },
};
