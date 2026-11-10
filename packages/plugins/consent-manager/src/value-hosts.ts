// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — the third-party hosts in content values, stored per content
 * instance, so judging a module reads no instance.
 *
 * A module's hosts are its source's (markup, CSS, JavaScript, field
 * defaults) plus, for every placement, the hosts of the values under the
 * keys its markup loads (`moduleSourceHosts`, `valueHostsByKey`). Reading
 * every instance of a module to find them made each content write cost
 * the module's whole usage: 50,000 rows for the page module of a 50k-page
 * site, on every write. So the value half is derived state here, one row
 * per instance, key and host, written where the change journal hands this
 * plugin an instance change, and rebuilt from the instances by the
 * consumer's rebuild (`scan_modules`). An instance holding no external URL
 * has no row, so the rows grow with embedded vendor URLs, not with pages.
 *
 * Branch-aware like every private table: a chat's batch writes its rows
 * on the chat's branch, and they publish with it.
 */

import type { PluginAdminQuery, PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { valueHostsByKey } from "./scan.js";
import { adminQueryOf, cmsOf } from "./storage.js";

/** One stored host of one instance's values. */
interface ValueHostRow {
  id: string;
  module_id: string;
  instance_id: string;
  key: string;
  host: string;
}

/** Rows and `anyOf` values per storage read — the broker's ceiling. */
const PAGE = 1000;

/** Every row matching `filter`, paged by id. */
async function readAll(
  q: PluginAdminQuery,
  filter: Record<string, unknown>,
): Promise<ValueHostRow[]> {
  const out: ValueHostRow[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = (await q.list("value_hosts", {
      ...filter,
      orderBy: "id",
      orderDir: "asc",
      limit: PAGE,
      ...(afterId ? { afterId } : {}),
    })) as unknown as ValueHostRow[];
    out.push(...page);
    if (page.length < PAGE) return out;
    afterId = page[page.length - 1]?.id;
  }
}

/** Rows whose `column` holds one of `values` (one read per 1000 values). */
async function readWhere(
  q: PluginAdminQuery,
  column: "module_id" | "instance_id",
  values: readonly string[],
): Promise<ValueHostRow[]> {
  const unique = [...new Set(values)];
  const out: ValueHostRow[] = [];
  for (let i = 0; i < unique.length; i += PAGE) {
    out.push(...(await readAll(q, { anyOf: { [column]: unique.slice(i, i + PAGE) } })));
  }
  return out;
}

const rowKey = (r: Pick<ValueHostRow, "module_id" | "instance_id" | "key" | "host">) =>
  `${r.instance_id}|${r.module_id}|${r.key}|${r.host}`;

/**
 * Bring the stored rows of `instanceIds` (or of every instance, `"all"`)
 * in line with their values as the caller's scope sees them. An instance
 * that is gone loses its rows.
 *
 * @returns the instances' modules (also those of removed instances) and
 *   how many rows were written or deleted.
 */
export async function refreshValueHosts(
  ctx: PluginContextTier1,
  instanceIds: readonly string[] | "all",
): Promise<{ moduleIds: Set<string>; changed: number }> {
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const all = instanceIds === "all";
  if (!all && instanceIds.length === 0) return { moduleIds: new Set(), changed: 0 };
  const instances: { id: string; moduleId: string; values: unknown }[] = [];
  if (all) {
    const r = await cms.call<{ instances: typeof instances }>("content_instances.list", {});
    instances.push(...r.instances);
  } else {
    for (let i = 0; i < instanceIds.length; i += PAGE) {
      const r = await cms.call<{ instances: typeof instances }>("content_instances.list", {
        ids: [...new Set(instanceIds.slice(i, i + PAGE))],
      });
      instances.push(...r.instances);
    }
  }
  const wanted = new Map<string, Omit<ValueHostRow, "id">>();
  for (const inst of instances) {
    for (const [key, hosts] of valueHostsByKey(inst.values ?? {})) {
      for (const host of hosts) {
        const row = { module_id: inst.moduleId, instance_id: inst.id, key, host };
        wanted.set(rowKey(row), row);
      }
    }
  }
  const stored = all ? await readAll(q, {}) : await readWhere(q, "instance_id", instanceIds);
  const moduleIds = new Set([
    ...instances.map((i) => i.moduleId),
    ...stored.map((r) => r.module_id),
  ]);
  let changed = 0;
  const kept = new Set<string>();
  for (const r of stored) {
    const k = rowKey(r);
    // A duplicate (two branches filled the same row) goes too.
    if (wanted.has(k) && !kept.has(k)) {
      kept.add(k);
      continue;
    }
    await q.delete("value_hosts", r.id);
    changed += 1;
  }
  for (const [k, row] of wanted) {
    if (kept.has(k)) continue;
    await q.insert("value_hosts", row);
    changed += 1;
  }
  return { moduleIds, changed };
}

/**
 * Per module, the stored hosts of its instances' values under `keysOf`
 * (the keys the module's markup loads).
 */
export async function valueHostsOfModules(
  q: PluginAdminQuery,
  keysOf: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const loading = [...keysOf].filter(([, keys]) => keys.length > 0).map(([id]) => id);
  for (const r of await readWhere(q, "module_id", loading)) {
    if (!keysOf.get(r.module_id)?.includes(r.key)) continue;
    const set = out.get(r.module_id) ?? new Set<string>();
    set.add(r.host);
    out.set(r.module_id, set);
  }
  return out;
}
