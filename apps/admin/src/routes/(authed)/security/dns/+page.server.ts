// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — DNS guidance. Shows the operator the DNS records the active
 * provider stack expects them to publish at their registrar, with a
 * live resolver-status badge per row. Sourced from
 * `provisioning_outputs.outputs_json.dnsRecordsRequired`, which the
 * cms-provision CLI's pulumi-output-sync subcommand populates after
 * every `pulumi up`.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface DnsRecord {
  hostname: string;
  type: "A" | "AAAA" | "CNAME" | "TXT";
  value: string;
  purpose: string;
}

interface ProvisioningOutputsRow {
  provider: "self-hosted" | "gcp" | "aws" | "azure";
  environment: "dev" | "staging" | "production";
  dnsRecordsRequired: DnsRecord[];
  bootstrapUrl: string | null;
  adminDatabaseUrlPrefix: string | null;
  outputsHash: string;
  syncedAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "provisioning_outputs.get", {});
  const rows = r.ok ? (r.value as { rows: ProvisioningOutputsRow[] }).rows : [];
  return { rows, error: r.ok ? null : r.error.kind };
};

export const actions: Actions = {
  verify: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const hostname = String(form.get("hostname") ?? "").trim();
    const type = String(form.get("type") ?? "");
    const expectedValue = String(form.get("expectedValue") ?? "").trim();
    if (!hostname || !["A", "AAAA", "CNAME", "TXT"].includes(type) || !expectedValue) {
      return fail(400, { error: "hostname + type + expectedValue required" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "dns.verify_record", {
      hostname,
      type,
      expectedValue,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    const v = r.value as {
      status: "ok" | "pending" | "mismatch" | "error";
      observed: string[];
      message: string | null;
    };
    return {
      ok: true,
      verified: { hostname, type, status: v.status, observed: v.observed, message: v.message },
    };
  },
};
