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
 * #967 — nothing is stored or applied until the client passed the
 * preflight against Google (both redirect URIs, the ID/secret pair) and the
 * Owner confirmed that everyone signs in once more: `preflight` checks
 * only, `save` checks again and then switches. With a client configured,
 * the page load asks Google whether both redirect URIs are still on it, so
 * a URI removed in the console later shows here with the fix.
 *
 * `settings.write` for every action: the client decides who can get past
 * the admin's first gate.
 */

import {
  checkClientRedirectUris,
  emailsNeedingSignInClient,
  type GoogleSignInConfigureResult,
  googleIapGate,
  googleSignInClientInputSchema,
  preflightGoogleSignInClient,
  recheckGoogleSignIn,
  removeGoogleSignInClient,
  type SelfCheckLine,
  saveGoogleSignInClient,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import {
  currentGoogleSignInAvailability,
  E2E_GOOGLE_OAUTH,
  E2E_NO_GOOGLE,
  E2E_SELF_CHECK,
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
    return {
      availability,
      client: null,
      outsideOrganisation: [] as string[],
      redirectChecks: [] as SelfCheckLine[],
    };
  }
  const [client, outsideOrganisation] = await Promise.all([
    configuredClient(locals),
    usersNeedingClient(locals, availability.organisationDomains),
  ]);
  // Two read-only GETs of Google's authorize endpoint (preflight.ts).
  const redirectChecks = client
    ? await checkClientRedirectUris(deps().check ?? { fetch }, {
        projectId: availability.projectId,
        clientId: client.clientId,
        brokerRedirectUri: availability.brokerRedirectUri,
      })
    : [];
  return { availability, client, outsideOrganisation, redirectChecks };
};

/** A configure result as the page's `form`; failures as 4xx/5xx with the step. */
function respond(
  action: "save" | "remove" | "check",
  r: GoogleSignInConfigureResult,
  clientId?: string,
) {
  if (!r.ok) {
    const status =
      r.step === "confirm" || r.step === "preflight" ? 400 : r.step === "secret" ? 502 : 500;
    return fail(status, {
      action,
      error: r.error,
      nextStep: r.nextStep,
      step: r.step,
      ...(r.checks ? { checks: [...r.checks] } : {}),
      // The ID stays for fixing in place; the secret is never echoed back.
      ...(clientId !== undefined ? { clientId } : {}),
    });
  }
  return { action, ok: true as const, checks: r.checks, allOk: r.checks.every((c) => c.ok) };
}

function available() {
  const a = currentGoogleSignInAvailability();
  return a.status === "available" ? a : null;
}

const NOT_AVAILABLE = "Google sign-in is not available on this install.";

const deps = () =>
  googleIapE2e()
    ? { google: E2E_NO_GOOGLE, preflight: E2E_GOOGLE_OAUTH, check: E2E_SELF_CHECK }
    : {};

/** The client form, parsed; a field-error result to return as-is when it is invalid. */
function parseClientForm(action: "preflight" | "save", form: FormData) {
  const clientId = String(form.get("clientId") ?? "");
  const parsed = googleSignInClientInputSchema.safeParse({
    clientId,
    clientSecret: String(form.get("clientSecret") ?? ""),
    consentConfirmed: form.get("consentConfirmed") === "yes",
    reLoginConfirmed: form.get("reLoginConfirmed") === "yes",
  });
  if (parsed.success) return { ok: true as const, input: parsed.data };
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? "form");
    fieldErrors[field] ??= issue.message;
  }
  // The secret is never echoed back; the client ID is, so it can be fixed in place.
  return {
    ok: false as const,
    response: fail(400, { action, error: "Check the highlighted fields.", fieldErrors, clientId }),
  };
}

export const actions: Actions = {
  /** #967 — "Check the client": ask Google, store nothing. */
  preflight: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target) return fail(409, { action: "preflight", error: NOT_AVAILABLE });
    const parsed = parseClientForm("preflight", form);
    if (!parsed.ok) return parsed.response;
    const r = await preflightGoogleSignInClient(target, parsed.input, deps());
    if (!r.ok) {
      return fail(400, {
        action: "preflight",
        error: r.error,
        nextStep: r.nextStep,
        step: r.step,
        checks: [...r.checks],
        clientId: parsed.input.clientId,
      });
    }
    return {
      action: "preflight",
      ok: true as const,
      passed: true as const,
      checks: [...r.checks],
      clientId: parsed.input.clientId,
      replacing: (await configuredClient(locals)) !== null,
    };
  },

  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const target = available();
    if (!target) return fail(409, { action: "save", error: NOT_AVAILABLE });
    const parsed = parseClientForm("save", form);
    if (!parsed.ok) return parsed.response;
    const { adapter, registry } = getQueryContext();
    const r = await saveGoogleSignInClient(
      registry,
      adapter,
      locals.ctx,
      target,
      parsed.input,
      deps(),
    );
    return respond("save", r, parsed.input.clientId);
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
