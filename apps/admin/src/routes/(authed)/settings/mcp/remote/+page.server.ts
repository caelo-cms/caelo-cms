// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — Settings → MCP → Remote: ChatGPT, claude.ai and other HTTP
 * MCP clients reach this install, signed in with Google and still gated by
 * IAP. Remote MCP signs people in with the install's Google sign-in client
 * (#914), set up under Settings → Google sign-in — never a client of its
 * own. This page keeps the MCP-specific parts: whether the broker answers,
 * and the URLs to hand to each client.
 */

import { runRemoteMcpSelfCheck } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { currentRemoteMcpAvailability } from "#lib/server/google-iap.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

type ConfiguredClient = { clientId: string; configuredAt: string } | null;

async function configuredClient(locals: App.Locals): Promise<ConfiguredClient> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "operator_oauth.get", {});
  if (!r.ok) throw new Error(`operator_oauth.get failed: ${JSON.stringify(r.error)}`);
  return (r.value as { client: ConfiguredClient }).client;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const availability = currentRemoteMcpAvailability();
  const client = availability.status === "available" ? await configuredClient(locals) : null;
  return { availability, client };
};

export const actions: Actions = {
  check: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = currentRemoteMcpAvailability();
    if (target.status !== "available") {
      return fail(409, { action: "check", error: "Remote MCP is not available on this install." });
    }
    const client = await configuredClient(locals);
    const checks = await runRemoteMcpSelfCheck(
      { fetch },
      { mcpPublicUrl: target.mcpPublicUrl, clientId: client?.clientId ?? null },
    );
    return { action: "check", ok: true as const, checks, allOk: checks.every((c) => c.ok) };
  },
};
