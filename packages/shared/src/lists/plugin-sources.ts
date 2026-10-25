// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin list sources as the resolver takes them (epic #1107,
 * `docs/lists.md` §6). Plugins still answer with the `dataLists` shape
 * (flat string records per claimed name) until the plugin SDK declares
 * `listSources` with a node definition (part G of the epic); this turns
 * that answer into {@link PluginSourceEntry} lists. Entries of the old
 * shape carry no id, so each gets its position — stable for one render,
 * which is all an entry of a generated source needs (it is never edited
 * or addressed).
 */

import type { PluginSourceEntry } from "./render-data.js";

/** Convert per-page plugin data lists to plugin source entries. */
export function pluginSourcesFromDataLists(
  lists: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string>>>>>,
): Record<string, PluginSourceEntry[]> {
  const out: Record<string, PluginSourceEntry[]> = {};
  for (const [name, items] of Object.entries(lists)) {
    out[name] = items.map((values, i) => ({ id: `${name}:${i}`, values }));
  }
  return out;
}
