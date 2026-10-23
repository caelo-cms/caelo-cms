// SPDX-License-Identifier: MPL-2.0

/**
 * Panel-side counterpart of the gated user tools' `afterApply`: once a user
 * change from /settings/users (or a role deletion from /settings/roles)
 * committed, start the operator-access sync job that brings Google IAP in
 * line (a no-op on installs without IAP), and turn the outcome into a
 * form-action result the layout toasts — `error` when the gate could not be
 * updated, so a silent 403 for the new user is never how the Owner finds out.
 *
 * #970 — `refusedMembers` carries the users Google has no account for (the
 * run applied everyone else), so the create form can say right after
 * saving that the new user cannot sign in yet.
 */

import { describeOperatorAccessSync, syncOperatorAccess } from "@caelo-cms/admin-core";
import { getQueryContext } from "./query.js";

export async function syncOperatorAccessFromPanel(
  locals: App.Locals,
): Promise<
  { ok: true | string; refusedMembers: string[] } | { error: string; refusedMembers: string[] }
> {
  const { adapter, registry } = getQueryContext();
  // The callers checked users.manage / roles.manage; the audit row is the
  // Owner's own.
  const sync = await syncOperatorAccess(registry, adapter, locals.ctx);
  const message = describeOperatorAccessSync(sync);
  const refusedMembers =
    sync.status === "synced" || sync.status === "failed" ? (sync.refusedMembers ?? []) : [];
  if (sync.status === "failed") {
    return { error: message ?? "Google IAP access sync failed.", refusedMembers };
  }
  return { ok: message ?? true, refusedMembers };
}
