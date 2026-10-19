// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — where this plugin stores internal links, for
 * core's one-time link migration.
 *
 * A language's own chrome (`chrome_variants.values`, written by
 * set_chrome_variants or translate_chrome before rollout C) can hold
 * literal paths like `/de/preise`. Since rollout D links resolve per
 * language from page REFERENCES only, so those literals must become
 * `caelo:page/<id>`. This hook only NAMES the rows; core reads, converts
 * (with the same canonicaliser `links.canonicalise_values` runs, in
 * report mode) and writes them inside the migration's transaction and
 * snapshot, so they revert together with core content.
 */

import type { PluginAdminQuery, PluginLinkLocation } from "@caelo-cms/plugin-sdk";
import { type ChromeCms, loadChromeTargets, loadChromeVariants } from "./chrome-ops.js";

/**
 * Every chrome variant that carries its own values. A variant with its
 * own module is read with that module's fields (core loads them); a
 * variant of the shared module with the target's fields.
 */
export async function chromeLinkLocations(
  q: PluginAdminQuery,
  cms: ChromeCms,
): Promise<{ locations: PluginLinkLocation[] }> {
  const variants = (await loadChromeVariants(q)).filter((v) => v.values !== null);
  if (variants.length === 0) return { locations: [] };
  const targets = new Map((await loadChromeTargets(cms)).map((t) => [t.key, t]));
  const locations: PluginLinkLocation[] = [];
  for (const v of variants) {
    const target = targets.get(v.target_key);
    const label = `${v.locale_code} version of ${target?.label ?? v.target_key}`;
    locations.push({
      table: "chrome_variants",
      rowId: v.id,
      column: "values",
      label: label.slice(0, 300),
      ...(v.module_id
        ? { moduleId: v.module_id }
        : target
          ? { fields: target.fields.map((f) => ({ name: f.name, kind: f.kind })) }
          : {}),
    });
  }
  return { locations };
}
