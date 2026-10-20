// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — Settings → MCP → Remote: the Owner's guided setup that lets
 * ChatGPT, claude.ai and other HTTP MCP clients reach this install, signed in
 * with Google and still gated by IAP. The steps and the self-check live in
 * admin-core (security/remote-mcp/); this route wires them to forms.
 *
 * `settings.write` for every action, like minting an MCP token: the client
 * decides who may call the IAP-protected admin programmatically.
 */

import {
  disableRemoteMcp,
  type RemoteMcpConfigureResult,
  recheckRemoteMcp,
  remoteMcpClientInputSchema,
  saveRemoteMcpClient,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import {
  currentRemoteMcpAvailability,
  E2E_NO_GOOGLE,
  remoteMcpE2e,
} from "#lib/server/remote-mcp.js";
import type { Actions, PageServerLoad } from "./$types";

type ConfiguredClient = { clientId: string; configuredAt: string } | null;

async function configuredClient(locals: App.Locals): Promise<ConfiguredClient> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "mcp_remote_oauth.get", {});
  if (!r.ok) throw new Error(`mcp_remote_oauth.get failed: ${JSON.stringify(r.error)}`);
  return (r.value as { client: ConfiguredClient }).client;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const availability = currentRemoteMcpAvailability();
  const client = availability.status === "available" ? await configuredClient(locals) : null;
  return { availability, client };
};

/** A configure result as the page's `form`; failures as 4xx/5xx with the step. */
function respond(action: "save" | "disable" | "check", r: RemoteMcpConfigureResult) {
  if (!r.ok) {
    return fail(r.step === "secret" ? 502 : 500, {
      action,
      error: r.error,
      nextStep: r.nextStep,
      step: r.step,
    });
  }
  return { action, ok: true as const, checks: r.checks, allOk: r.checks.every((c) => c.ok) };
}

function available() {
  const a = currentRemoteMcpAvailability();
  return a.status === "available" ? a : null;
}

const deps = () => (remoteMcpE2e() ? { google: E2E_NO_GOOGLE } : {});

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target)
      return fail(409, { action: "save", error: "Remote MCP is not available on this install." });
    const parsed = remoteMcpClientInputSchema.safeParse({
      clientId: String(form.get("clientId") ?? ""),
      clientSecret: String(form.get("clientSecret") ?? ""),
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "form");
        fieldErrors[field] ??= issue.message;
      }
      // The secret is never echoed back; the client ID is, so it can be fixed in place.
      return fail(400, {
        action: "save",
        error: "Check the highlighted fields.",
        fieldErrors,
        clientId: String(form.get("clientId") ?? ""),
      });
    }
    const { adapter, registry } = getQueryContext();
    return respond(
      "save",
      await saveRemoteMcpClient(registry, adapter, locals.ctx, target, parsed.data, deps()),
    );
  },

  disable: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target)
      return fail(409, {
        action: "disable",
        error: "Remote MCP is not available on this install.",
      });
    const { adapter, registry } = getQueryContext();
    return respond(
      "disable",
      await disableRemoteMcp(registry, adapter, locals.ctx, target, deps()),
    );
  },

  check: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target)
      return fail(409, { action: "check", error: "Remote MCP is not available on this install." });
    const client = await configuredClient(locals);
    const { adapter, registry } = getQueryContext();
    return respond(
      "check",
      await recheckRemoteMcp(
        registry,
        adapter,
        locals.ctx,
        target,
        client?.clientId ?? null,
        deps(),
      ),
    );
  },
};
