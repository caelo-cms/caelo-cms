// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 0 — Settings → Updates: the release this install runs, the
 * newest release with its notes, and (for whoever may change settings —
 * the Owner by default) the exact, version-pinned command that upgrades
 * this install. Anyone with settings.read sees the versions; the command
 * needs settings.write because running it is an Owner decision.
 *
 * Nothing here installs anything: the AI only reads the same status
 * (`get_caelo_version`), and in-product installs arrive in a later phase.
 */

import type { PlatformUpdateStatus } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import { resolveUpgradePath, type UpgradePath } from "#lib/upgrade-path.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "platform_updates.status", {});
  if (!r.ok) throw error(500, opErrorMessage(r.error, "could not read the update status"));
  const status = r.value as PlatformUpdateStatus;
  const canUpgrade = user.permissions.has("settings.write");
  // Only built for those who may run it, and only when there is a newer
  // release to name — the command always carries an exact version.
  const upgrade: UpgradePath | null =
    canUpgrade && status.upgradeAvailable && status.latestVersion
      ? resolveUpgradePath(process.env, status.latestVersion)
      : null;
  return { status, canUpgrade, upgrade };
};
