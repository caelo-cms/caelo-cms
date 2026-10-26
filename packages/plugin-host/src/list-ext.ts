// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — definition extensions (`docs/lists.md` §9.2): the schemas
 * a RUNNING plugin declared for `ext.<pluginSlug>` on list-type field and
 * node definitions.
 *
 * Core stores these attributes and validates them, but never interprets
 * them. "Running" is the activation hard state (CLAUDE.md §2): a plugin
 * that is not loaded, or that an Owner disabled, has no schema here — its
 * attributes stay as inert data, and a write that would add or change
 * them is refused by the list-type ops (they say how to fix it).
 */

import type { PluginListExt } from "@caelo-cms/plugin-sdk";
import { z } from "zod";
import { isPluginDisabled, loadedPlugins } from "./dispatch.js";

/** A running plugin's compiled extension schemas. */
export interface ActiveListExt {
  readonly field?: z.ZodType;
  readonly node?: z.ZodType;
}

const compiled = new Map<string, { version: string; ext: ActiveListExt }>();

/** Compile a declared `listExt`; throws on a schema the host cannot compile. */
export function compileListExt(ext: PluginListExt): ActiveListExt {
  return {
    ...(ext.field
      ? { field: z.fromJSONSchema(ext.field as Parameters<typeof z.fromJSONSchema>[0]) }
      : {}),
    ...(ext.node
      ? { node: z.fromJSONSchema(ext.node as Parameters<typeof z.fromJSONSchema>[0]) }
      : {}),
  };
}

/**
 * The extension schemas of `pluginSlug` while it runs here; null when the
 * plugin is not running or declares none.
 */
export function activeListExt(pluginSlug: string): ActiveListExt | null {
  const lp = loadedPlugins.bySlug(pluginSlug);
  if (!lp || isPluginDisabled(pluginSlug) || !lp.definition.listExt) return null;
  const hit = compiled.get(pluginSlug);
  if (hit && hit.version === lp.version) return hit.ext;
  const ext = compileListExt(lp.definition.listExt);
  compiled.set(pluginSlug, { version: lp.version, ext });
  return ext;
}
