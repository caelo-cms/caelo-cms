// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — which pages a plugin operation made stale, read from the
 * plugin's `bakedData` declaration (plugin SDK).
 *
 * After a declared trigger succeeds, the host takes the page id(s) from
 * the key the declaration names — of the operation's arguments or of its
 * result — and asks for those pages to be re-baked by the next
 * plugin-data build. In the admin the ids come from the admin's own call
 * (audited); in the gateway the one page id is written into the visitor
 * op event, which the admin reads back as an UNTRUSTED hint
 * (docs/dev/public-admin-boundary.md) and checks against the declaration
 * of the plugin it has loaded ({@link bakedDataVisitorTrigger}).
 *
 * Only plugins that are loaded declare anything: an inactive plugin is
 * not loaded (CLAUDE.md §2 activation is a hard state), so its triggers
 * do not exist here.
 */

import { bakedDataTrigger } from "./baked-data-pages.js";
import { isPluginDisabled, loadedPlugins } from "./dispatch.js";

/** A plugin whose bakes a plugin-data build refreshes. */
export interface BakedDataPlugin {
  readonly id: string;
  readonly slug: string;
  readonly version: string;
}

/**
 * The loaded, enabled plugin with id `pluginId` when it declares
 * `operationName` as a baked-data trigger that visitors call (it is in
 * the plugin's `publicOperations`); else null. This is the allowlist an
 * untrusted visitor hint is checked against.
 */
export function bakedDataVisitorTrigger(
  pluginId: string,
  operationName: string,
): BakedDataPlugin | null {
  const lp = loadedPlugins.all().find((p) => p.pluginId === pluginId);
  if (!lp || isPluginDisabled(lp.slug)) return null;
  if (!bakedDataTrigger(lp.definition.bakedData, operationName)) return null;
  if (!(lp.definition.publicOperations ?? []).includes(operationName)) return null;
  return { id: lp.pluginId, slug: lp.slug, version: lp.version };
}

/**
 * The loaded, enabled Tier-1 plugin `pluginId` when it declares baked data
 * and can render it; null otherwise (not loaded here, disabled, or no
 * declaration — its marks then wait for an instance that runs it).
 */
export function bakedDataPlugin(pluginId: string): BakedDataPlugin | null {
  const lp = loadedPlugins.all().find((p) => p.pluginId === pluginId);
  if (!lp || isPluginDisabled(lp.slug)) return null;
  // Tier 1 only, like the build's plugin render pass
  // (build-services.ts `staticRenderPlugins`): only those bakes exist.
  if (lp.tier !== 1 || !lp.definition.bakedData) return null;
  if (typeof lp.definition.staticRender !== "function") return null;
  return { id: lp.pluginId, slug: lp.slug, version: lp.version };
}
