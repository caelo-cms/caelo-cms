// SPDX-License-Identifier: MPL-2.0

import type { McpRemoteAccessBlockRow, McpRemoteConnectionRow } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { MCP_SURFACE_PERMISSION } from "@caelo-cms/shared";
import { error, fail } from "@sveltejs/kit";
import type { RemoteMcpState } from "#lib/mcp-remote-access.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { currentRemoteMcpAvailability } from "#lib/server/google-iap.js";
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

/**
 * Where remote MCP stands on this install, for the state-aware top card
 * (#968): never "set up" once it is on, always both URLs when it is.
 */
async function remoteState(locals: App.Locals): Promise<RemoteMcpState> {
  const availability = currentRemoteMcpAvailability();
  if (availability.status === "not-available") return availability;
  if (availability.status === "needs-upgrade") return availability;
  const { adapter, registry } = getQueryContext();
  const client = await execute(registry, adapter, locals.ctx, "operator_oauth.get", {});
  if (!client.ok) throw error(500, `operator_oauth.get failed: ${JSON.stringify(client.error)}`);
  // Remote MCP is on exactly when the install's Google sign-in client is
  // set (#914: no separate switch).
  if ((client.value as { client: unknown }).client === null) {
    return { status: "off", signInSettingsPath: availability.signInSettingsPath };
  }
  const seo = await execute(registry, adapter, locals.ctx, "site_defaults.get_seo", {});
  if (!seo.ok) throw error(500, `site_defaults.get_seo failed: ${JSON.stringify(seo.error)}`);
  // The connector name names the site; before its base URL is configured
  // the MCP address's own host is the site's address people know.
  const base = (seo.value as { siteBaseUrl: string | null }).siteBaseUrl;
  const siteHost = new URL(base ?? availability.mcpPublicUrl).host;
  return { status: "on", urls: availability.urls, siteHost };
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const permissions = locals.user?.permissions;
  const canWrite = permissions?.has("settings.write") === true;
  // Which remote surfaces this user may connect — the URLs shown follow it.
  const mayUse = {
    chat: permissions?.has(MCP_SURFACE_PERMISSION.chat) === true,
    admin: permissions?.has(MCP_SURFACE_PERMISSION.admin) === true,
  };
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
  // Issue #806/#968 — apps connected by URL (IAP identity), one row per
  // (user, surface, app), plus users an Owner blocked for every app.
  const remote = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.list", {});
  if (!remote.ok) {
    throw error(500, "Could not load the remote MCP connections (mcp_remote_connections.list).");
  }
  const { connections: remoteConnections, blocks: remoteBlocks } = remote.value as {
    connections: McpRemoteConnectionRow[];
    blocks: McpRemoteAccessBlockRow[];
  };
  return {
    tokens,
    visibility,
    adminUrl,
    iapServiceAccount,
    remote: await remoteState(locals),
    mayUse,
    remoteConnections,
    remoteBlocks,
    canWrite,
    selfId: locals.user?.id ?? null,
  };
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
  remoteBlockUser: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const actorId = String(form.get("actorId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.block_user", {
      actorId,
    });
    if (!r.ok) return fail(400, { error: opMessage(r.error) });
    return { ok: true, remoteUpdated: actorId };
  },
  remoteUnblockUser: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const actorId = String(form.get("actorId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "mcp_remote_connections.unblock_user", {
      actorId,
    });
    if (!r.ok) return fail(400, { error: opMessage(r.error) });
    return { ok: true, remoteUpdated: actorId };
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
