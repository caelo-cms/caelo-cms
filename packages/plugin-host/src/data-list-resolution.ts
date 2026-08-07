// SPDX-License-Identifier: MPL-2.0

/**
 * Resolve plugin data lists for a set of pages, batched per plugin.
 *
 * Mirrors `collectContributions` (head/sitemap): one operation call per
 * contributing plugin covering every page in the render pass, rather
 * than a call per page. Both render paths — the editor preview and the
 * static generator — go through here, so a module renders identically
 * in the editor and on the deployed site.
 *
 * Loud, per CLAUDE.md §2: a failing resolver op throws rather than
 * yielding an empty list. "The plugin is broken" and "this page has no
 * translations" must never look the same — one is a bug to fix, the
 * other is the correct empty state.
 */

import { type DataListItem, pluginDataListsRegistry } from "./data-lists.js";
import { runPluginOperation } from "./dispatch.js";

/** pageId → listName → items. Missing page/list means "not offered". */
export type ResolvedDataLists = ReadonlyMap<string, Readonly<Record<string, DataListItem[]>>>;

function coerceItems(raw: unknown, where: string): DataListItem[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${where}: expected an array of items, got ${typeof raw}`);
  }
  return raw.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${where}[${i}]: expected an object of string fields`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      // Flat strings only. A nested object would substitute as
      // "[object Object]" into the page — visible nonsense that no
      // reviewer would attribute to the plugin.
      if (typeof v !== "string") {
        throw new Error(`${where}[${i}].${k}: data-list values must be strings, got ${typeof v}`);
      }
      out[k] = v;
    }
    return out;
  });
}

/**
 * @param pageIds pages being rendered in this pass.
 * @returns the lists each page may iterate. Empty when no active
 *   plugin offers any — the common single-language case, which costs
 *   zero plugin calls.
 */
export async function resolveDataLists(pageIds: ReadonlyArray<string>): Promise<ResolvedDataLists> {
  const out = new Map<string, Record<string, DataListItem[]>>();
  if (pageIds.length === 0) return out;
  const sources = pluginDataListsRegistry.activeByOperation();
  if (sources.size === 0) return out;

  for (const source of sources.values()) {
    const r = await runPluginOperation({
      pluginSlug: source.pluginSlug,
      operationName: source.operationName,
      args: { pageIds: [...pageIds] },
    });
    if (!r.ok) {
      throw new Error(
        `data-lists: ${source.pluginSlug}.${source.operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const lists = (r.value as { lists?: Record<string, Record<string, unknown>> }).lists ?? {};
    const claimed = new Set(source.names);
    for (const [pageId, byName] of Object.entries(lists)) {
      const bucket = out.get(pageId) ?? {};
      for (const [name, raw] of Object.entries(byName)) {
        // A plugin may only fill names it claimed. Anything else would
        // let it shadow another plugin's list by answering for it.
        if (!claimed.has(name)) {
          throw new Error(
            `data-lists: plugin "${source.pluginSlug}" returned list "${name}", which it did not declare`,
          );
        }
        bucket[name] = coerceItems(raw, `${source.pluginSlug}.${name} (page ${pageId})`);
      }
      out.set(pageId, bucket);
    }
  }
  return out;
}
