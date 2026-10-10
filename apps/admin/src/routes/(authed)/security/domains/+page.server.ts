// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — domains registry. Real now (placeholder before).
 *  - Lists every hostname the gateway / static site serves.
 *  - Owner can add / remove / verify-DNS-now.
 *  - cms-provision regenerate-caddy reads the same table at deploy.
 *  - gcp-firebase: the live Firebase Hosting custom-domain state, with a
 *    Reconnect action for a domain that is stuck (same op the AI's
 *    propose_reconnect_domain applies after approval).
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface Domain {
  id: string;
  hostname: string;
  kind: "admin" | "public";
  tlsStatus: "pending" | "active" | "failed" | "unknown";
  tlsExpiresAt: string | null;
  tlsError: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
}

interface HostingDomain {
  hostname: string;
  status: "active" | "dns_pending" | "provisioning" | "stuck" | "deleted";
  hostState: string;
  ownershipState: string;
  certState: string;
  checkTime: string | null;
  summary: string;
}

interface HostingStatus {
  supported: boolean;
  domains: HostingDomain[];
  cdnPurge: { versionName: string; hostnames: string[] } | null;
  error: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "domains.list", {});
  const domains = r.ok ? (r.value as { domains: Domain[] }).domains : [];
  const h = await execute(registry, adapter, locals.ctx, "domains.hosting_status", {});
  const hosting: HostingStatus = h.ok
    ? (h.value as HostingStatus)
    : { supported: true, domains: [], cdnPurge: null, error: h.error.kind };
  return { domains, hosting, error: r.ok ? null : r.error.kind };
};

export const actions: Actions = {
  add: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const hostname = (form.get("hostname") as string) ?? "";
    const kind = (form.get("kind") as string) ?? "public";
    if (!["admin", "public"].includes(kind)) {
      return fail(400, { error: "kind must be admin/public" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "domains.add", {
      hostname,
      kind,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return {
      ok: true,
      message: `Added ${hostname}. Run \`bunx cms-provision regenerate-caddy\` so Caddy picks up the new vhost.`,
    };
  },
  remove: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("domainId");
    if (typeof id !== "string") return fail(400, { error: "domainId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "domains.remove", {
      domainId: id,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Domain removed." };
  },
  reconnect: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const hostname = form.get("hostname");
    if (typeof hostname !== "string") return fail(400, { error: "hostname required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "domains.reconnect_hosting", {
      hostname,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : r.error.kind;
      return fail(400, { error: message });
    }
    return { ok: true, message: (r.value as { message: string }).message };
  },
  verify: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("domainId");
    if (typeof id !== "string") return fail(400, { error: "domainId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "domains.verify", {
      domainId: id,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    const v = r.value as { hostname: string; a: string[]; aaaa: string[]; resolved: boolean };
    return {
      ok: true,
      message: v.resolved
        ? `${v.hostname} resolves: A=[${v.a.join(", ") || "—"}] AAAA=[${v.aaaa.join(", ") || "—"}]. ACME will pick it up on next Caddy reload.`
        : `${v.hostname} does NOT resolve yet. Add an A or AAAA record at your DNS provider before Caddy can request a cert.`,
    };
  },
};
