// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

type TokenRow = {
  id: string;
  actorId: string;
  displayName: string;
  scope: "chat" | "admin";
  aiCostCapMicrocents: number | null;
  allowCaeloAi: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  expiresAt: string;
};

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.list", {});
  if (!r.ok) throw error(500, `Could not list MCP tokens: ${JSON.stringify(r.error)}`);
  // RLS (migration 0315) scopes the rows: an Owner (settings.write) gets
  // every user's tokens, everyone else only their own.
  const { tokens, visibility } = r.value as { tokens: TokenRow[]; visibility: "all" | "own" };
  // The admin install's public URL — surfaces in the `claude mcp add`
  // snippet the create-flow shows. Best-effort: derive from request URL.
  const adminUrl = `${url.protocol}//${url.host}`;
  // Issue #37 — set by the provisioner on IAP-protected installs; the MCP
  // shim needs it to get through IAP.
  const iapServiceAccount = process.env.CAELO_MCP_IAP_SERVICE_ACCOUNT?.trim() || null;
  return { tokens, visibility, adminUrl, iapServiceAccount };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const displayName = String(form.get("displayName") ?? "").trim();
    const capRaw = String(form.get("aiCostCapMicrocents") ?? "");
    const scopeRaw = String(form.get("scope") ?? "chat");
    // #741 — the checkbox only renders for admin tokens; the op refuses it on chat.
    const allowCaeloAi = scopeRaw === "admin" && form.get("allowCaeloAi") === "on";
    if (!displayName) return fail(400, { error: "displayName required" });
    if (scopeRaw !== "chat" && scopeRaw !== "admin") {
      return fail(400, { error: "scope must be 'chat' or 'admin'" });
    }
    const cap = capRaw === "" ? null : Number.parseInt(capRaw, 10);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
      return fail(400, { error: "aiCostCapMicrocents must be a non-negative integer" });
    }
    const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.create", {
      displayName,
      scope: scopeRaw,
      aiCostCapMicrocents: cap,
      allowCaeloAi,
    });
    if (!r.ok) return fail(400, { error: "could not create token" });
    const v = r.value as { id: string; plaintextToken: string };
    // Returned ONCE — the page renders it as a save-now banner, then the
    // user copies + pastes into their `claude mcp add` invocation.
    return { ok: true, id: v.id, plaintextToken: v.plaintextToken, displayName, scope: scopeRaw };
  },
  revoke: async ({ request, locals }) => {
    // Anyone who can open this page may revoke a token they can see: RLS
    // (migration 0315) limits a non-Owner to their own tokens, so this only
    // ever narrows access. Revoking another user's token needs settings.write.
    requirePermission(locals, "settings.read");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.revoke", { id });
    if (!r.ok) {
      const message = "message" in r.error ? r.error.message : "could not revoke token";
      return fail(400, { error: message });
    }
    return { ok: true, revoked: id };
  },
};
