// SPDX-License-Identifier: MPL-2.0

/**
 * /settings/users — create, update and delete admin users. On Google IAP
 * installs every change starts the operator-access sync job.
 *
 * #970 — a user whose email has no Google account can never pass IAP. The
 * job's latest run report names them; the page lists them ("no Google
 * account, cannot sign in") with Delete / Change email next to each, and a
 * run whose only problem is such users is not shown as failed. Google
 * offers no read-only way to ask whether an address is a Google account
 * (IAM's policy lint checks binding conditions only; only a policy WRITE
 * answers "User … does not exist"), so creation cannot be checked before
 * saving: the create form shows the first sync's answer right after.
 */

import { latestOperatorAccessRun } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { syncOperatorAccessFromPanel } from "#lib/server/operator-access.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** System kind for cross-user writes on self-or-system RLS tables (see create). */
const asSystem = (locals: App.Locals) => ({ ...locals.ctx, actorKind: "system" as const });

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "users.manage");
  const { adapter, registry } = getQueryContext();

  const [usersResult, rolesResult, operatorAccess] = await Promise.all([
    execute(registry, adapter, locals.ctx, "users.list", {}),
    execute(registry, adapter, locals.ctx, "roles.list", {}),
    // Latest run of the Google IAP sync job (null without IAP), so a failed
    // scheduled run shows here instead of only in Cloud Logging.
    latestOperatorAccessRun(registry, adapter, locals.ctx),
  ]);

  const users = usersResult.ok
    ? (
        usersResult.value as {
          users: {
            id: string;
            email: string;
            displayName: string;
            isFirstOwner: boolean;
            roles: string[];
          }[];
        }
      ).users
    : [];

  const roles = rolesResult.ok
    ? (rolesResult.value as { roles: { name: string }[] }).roles.map((r) => r.name)
    : [];

  // #970 — the users the latest run's report says Google has no account
  // for, as they are now (a deleted or re-addressed user drops out).
  const refused = new Set(
    operatorAccess?.status === "ok" ? (operatorAccess.report?.refusedMembers ?? []) : [],
  );
  const noGoogleAccount = users
    .filter((u) => refused.has(u.email.toLowerCase()))
    .map((u) => ({ id: u.id, email: u.email, isFirstOwner: u.isFirstOwner }));

  return { users, roles, operatorAccess, noGoogleAccount };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("displayName") ?? "").trim();
    const roleNames = form.getAll("roleNames").map(String).filter(Boolean);

    // Elevated like resetPassword below: creating ANOTHER user's actor/users
    // rows clears self-or-system RLS only as system (a bare human owner is
    // blocked). `users.manage` was checked above; the owner id stays on audit.
    const result = await execute(registry, adapter, asSystem(locals), "users.create", {
      email,
      password,
      displayName,
      roleNames,
    });
    // #914 — the op's own message carries the reason and the next step
    // (a duplicate email, a weak password, an address the identity gate in
    // front of the admin would never let through).
    if (!result.ok) {
      return fail(400, { error: opErrorMessage(result.error, "Could not create user.") });
    }
    // #970 — the first sync is the only way to learn whether Google knows
    // the address; its answer goes straight back to the create form.
    const sync = await syncOperatorAccessFromPanel(locals);
    return {
      ...sync,
      createdEmail: email,
      createdWithoutGoogleAccount: sync.refusedMembers.includes(email.toLowerCase()),
    };
  },

  /** #970 — fix a user whose address has no Google account (or any typo). */
  changeEmail: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const email = String(form.get("email") ?? "").trim();
    // Elevated like create: another user's `users` row is self-or-system under RLS.
    const result = await execute(registry, adapter, asSystem(locals), "users.set_email", {
      userId,
      email,
    });
    if (!result.ok) {
      return fail(400, {
        error: opErrorMessage(result.error, "Could not change the email."),
        changeEmailUserId: userId,
      });
    }
    return syncOperatorAccessFromPanel(locals);
  },

  setRoles: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const roleNames = form.getAll("roleNames").map(String).filter(Boolean);

    const result = await execute(registry, adapter, locals.ctx, "users.set_roles", {
      userId,
      roleNames,
    });
    if (!result.ok) return fail(400, { error: "Could not update roles." });
    return syncOperatorAccessFromPanel(locals);
  },

  delete: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const result = await execute(registry, adapter, asSystem(locals), "users.delete", { userId });
    if (!result.ok) return fail(400, { error: "Could not delete user." });
    return syncOperatorAccessFromPanel(locals);
  },

  /**
   * Recompute Google IAP access for every user, deleted ones included — the
   * retry path when an automatic sync after a user change failed (the change
   * itself was saved, so it cannot be approved again).
   */
  resyncOperatorAccess: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    return syncOperatorAccessFromPanel(locals);
  },

  resetPassword: async ({ request, locals }) => {
    requirePermission(locals, "users.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const userId = String(form.get("userId") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");

    // Elevate to a system kind so the cross-user write clears the self-or-system
    // RLS on `users`/`sessions` (a bare human owner is blocked); keep the owner
    // id for audit attribution. `users.manage` was checked above.
    const result = await execute(
      registry,
      adapter,
      { ...locals.ctx, actorKind: "system" },
      "users.admin_set_password",
      { userId, newPassword },
    );
    if (!result.ok) {
      return fail(400, { error: opErrorMessage(result.error, "Could not reset the password.") });
    }
    return { ok: true, resetUserId: userId };
  },
};
