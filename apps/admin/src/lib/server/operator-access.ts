// SPDX-License-Identifier: MPL-2.0

/**
 * Panel-side counterpart of the gated user tools' `afterApply`: once a user
 * change from /security/users committed, bring Google IAP in line (a no-op on
 * installs without IAP) and turn the outcome into a form-action result the
 * layout toasts — `error` when the gate could not be updated, so a silent 403
 * for the new user is never how the Owner finds out.
 */

import { describeOperatorAccessSync, type OperatorAccessSync } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { opErrorMessage } from "./op-error.js";
import { getQueryContext } from "./query.js";

export async function syncOperatorAccess(
  locals: App.Locals,
  userId: string,
): Promise<{ ok: true | string } | { error: string }> {
  const { adapter, registry } = getQueryContext();
  // Elevated like resetPassword: `users` RLS is self-or-system, and the
  // sync must see the changed user's row. The callers checked users.manage;
  // the Owner's actorId stays on the audit row.
  const r = await execute(
    registry,
    adapter,
    { ...locals.ctx, actorKind: "system" },
    "users.sync_operator_access",
    { userIds: [userId] },
  );
  if (!r.ok) {
    return {
      error: `The user change was saved, but Google IAP access could not be updated: ${opErrorMessage(r.error, "sync failed")}.`,
    };
  }
  const sync = r.value as OperatorAccessSync;
  const message = describeOperatorAccessSync(sync);
  if (sync.status === "failed") return { error: message ?? "Google IAP access sync failed." };
  return { ok: message ?? true };
}
