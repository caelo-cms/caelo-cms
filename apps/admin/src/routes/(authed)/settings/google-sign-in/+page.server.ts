// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — Settings → Google sign-in: the Owner's guided setup of the
 * install's one Google OAuth client. With it, Google IAP signs people in
 * with this client instead of its Google-managed one, so users outside the
 * project's Google organisation (gmail.com, another company's Workspace)
 * can reach the admin; remote MCP signs in with the same client. The steps
 * and the self-check live in admin-core (security/google-sign-in/); this
 * route wires them to forms.
 *
 * `settings.write` for every action: the client decides who can get past
 * the admin's first gate.
 */

import {
  emailsNeedingSignInClient,
  type GoogleSignInConfigureResult,
  googleIapGate,
  googleSignInClientInputSchema,
  recheckGoogleSignIn,
  removeGoogleSignInClient,
  saveGoogleSignInClient,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import {
  currentGoogleSignInAvailability,
  E2E_NO_GOOGLE,
  googleIapE2e,
} from "#lib/server/google-iap.js";
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

/**
 * The users who can sign in only through this client: outside the
 * organisation IAP's built-in sign-in admits. Shown while it is missing,
 * and in the warning before removing it.
 */
async function usersNeedingClient(
  locals: App.Locals,
  organisationDomains: readonly string[] | "none" | "unknown",
): Promise<string[]> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "users.list", {});
  if (!r.ok) throw new Error(`users.list failed: ${JSON.stringify(r.error)}`);
  const users = (r.value as { users: { email: string; roles: string[] }[] }).users;
  // Only users with a role pass IAP at all (users.operator_access_members).
  const emails = users.filter((u) => u.roles.length > 0).map((u) => u.email);
  return emailsNeedingSignInClient(googleIapGate(organisationDomains), emails);
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const availability = currentGoogleSignInAvailability();
  if (availability.status !== "available") {
    return { availability, client: null, outsideOrganisation: [] as string[] };
  }
  const [client, outsideOrganisation] = await Promise.all([
    configuredClient(locals),
    usersNeedingClient(locals, availability.organisationDomains),
  ]);
  return { availability, client, outsideOrganisation };
};

/** A configure result as the page's `form`; failures as 4xx/5xx with the step. */
function respond(action: "save" | "remove" | "check", r: GoogleSignInConfigureResult) {
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
  const a = currentGoogleSignInAvailability();
  return a.status === "available" ? a : null;
}

const NOT_AVAILABLE = "Google sign-in is not available on this install.";

const deps = () => (googleIapE2e() ? { google: E2E_NO_GOOGLE } : {});

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target) return fail(409, { action: "save", error: NOT_AVAILABLE });
    const parsed = googleSignInClientInputSchema.safeParse({
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
      await saveGoogleSignInClient(registry, adapter, locals.ctx, target, parsed.data, deps()),
    );
  },

  remove: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target) return fail(409, { action: "remove", error: NOT_AVAILABLE });
    // The page names who loses access before this button appears; a request
    // without that confirmation (a stale tab, a crafted POST) changes nothing.
    if (form.get("confirm") !== "remove") {
      return fail(400, {
        action: "remove",
        error: "Confirm the removal: the users listed on the page lose access to the admin.",
      });
    }
    const client = await configuredClient(locals);
    const { adapter, registry } = getQueryContext();
    return respond(
      "remove",
      await removeGoogleSignInClient(
        registry,
        adapter,
        locals.ctx,
        target,
        client?.clientId ?? null,
        deps(),
      ),
    );
  },

  check: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target) return fail(409, { action: "check", error: NOT_AVAILABLE });
    const client = await configuredClient(locals);
    const { adapter, registry } = getQueryContext();
    return respond(
      "check",
      await recheckGoogleSignIn(
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
