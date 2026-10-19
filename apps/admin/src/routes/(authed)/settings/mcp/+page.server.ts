// SPDX-License-Identifier: MPL-2.0

import type { McpRemoteConnectionRow } from "@caelo-cms/admin-core";
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
  const tokens: TokenRow[] = r.ok ? ((r.value as { tokens: TokenRow[] }).tokens ?? []) : [];
  // The admin install's public URL — surfaces in the `claude mcp add`
  // snippet the create-flow shows. Best-effort: derive from request URL.
  const adminUrl = `${url.protocol}//${url.host}`;
  // Issue #37 — set by the provisioner on IAP-protected installs; the MCP
  // shim needs it to get through IAP.
  const iapServiceAccount = process.env.CAELO_MCP_IAP_SERVICE_ACCOUNT?.trim() || null;
  // Issue #806 — people connected through a remote MCP client (IAP identity).
  const remote = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.list", {});
  if (!remote.ok) {
    throw error(500, "Could not load the remote MCP connections (mcp_remote_connections.list).");
  }
  const remoteConnections = (remote.value as { connections: McpRemoteConnectionRow[] }).connections;
  const canWrite = locals.user?.permissions.has("settings.write") === true;
  return { tokens, adminUrl, iapServiceAccount, remoteConnections, canWrite };
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
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "mcp_tokens.revoke", { id });
    if (!r.ok) return fail(400, { error: "could not revoke token" });
    return { ok: true, revoked: id };
  },
  // Issue #806 — the Remote connections card (McpRemoteConnections.svelte).
  remoteRevoke: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.revoke", { id });
    if (!r.ok) return fail(400, { error: opMessage(r.error) });
    return { ok: true, remoteUpdated: id };
  },
  remoteRestore: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.restore", {
      id,
    });
    if (!r.ok) return fail(400, { error: opMessage(r.error) });
    return { ok: true, remoteUpdated: id };
  },
  remoteSetCap: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const id = String(form.get("id") ?? "");
    const capRaw = String(form.get("aiCostCapMicrocents") ?? "").trim();
    const cap = capRaw === "" ? null : Number.parseInt(capRaw, 10);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
      return fail(400, {
        error: "The cap must be a non-negative whole number of microcents, or blank.",
      });
    }
    const { adapter, registry } = getQueryContext();
    // The checkbox only renders for admin-surface rows (an unchecked box
    // sends nothing, so the row's surface says whether to apply it); the op
    // refuses the flag on chat rows.
    const isAdminRow = form.get("surface") === "admin";
    const r = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.set_cap", {
      id,
      aiCostCapMicrocents: cap,
      ...(isAdminRow ? { allowCaeloAi: form.get("allowCaeloAi") === "on" } : {}),
    });
    if (!r.ok) return fail(400, { error: opMessage(r.error) });
    return { ok: true, remoteUpdated: id };
  },
};

function opMessage(e: { kind: string } & Partial<{ message: string }>): string {
  return e.message ?? e.kind;
}
