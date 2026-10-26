// SPDX-License-Identifier: MPL-2.0

import { pluginListSourcesRegistry } from "@caelo-cms/plugin-host";

/**
 * Every list-source name a plugin claims, running or not (#447, epic
 * #1107). Dormant names count: a module written while a plugin ran must
 * stay editable after it is switched off, or turning a plugin off would
 * make its modules unsaveable.
 *
 * Shared by every path that checks a module's placeholders against its
 * fields — the direct create/update ops and the AI's moduleize step — so a
 * module iterating `{{#consent_categories}}` is valid on all of them.
 */
export function claimedListSourceNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of pluginListSourcesRegistry.catalogue()) names.add(entry.name);
  return names;
}
