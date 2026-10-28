// SPDX-License-Identifier: MPL-2.0

/**
 * #1100 — `update_modules_many` takes a module's `fields` as the whole list
 * (order and membership are the AI's call), but a field the AI resends
 * without `default` keeps the default it has. Before, widening one field's
 * `allowedModuleTypes` on a 37-field module meant re-typing every label and
 * default from guesses, and every default the AI did not know was lost —
 * placements without their own content then rendered empty.
 *
 * Only `default` is carried over: it is copy, the AI cannot invent it, and
 * leaving it out never means "remove" (an empty string does). Every other
 * key the AI sends is what it wants; `read_content` with `field:"fields"`
 * shows the full stored schema before an edit.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext, ModuleField } from "@caelo-cms/shared";
import type { ToolContext } from "./dispatch.js";

/** The stored field schema of a module as the caller's branch sees it, or null. */
export async function storedModuleFields(
  ctx: ExecutionContext,
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
  moduleId: string,
): Promise<readonly ModuleField[] | null> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.get", { moduleId });
  if (!r.ok) return null;
  return (r.value as { module: { fields: ModuleField[] } }).module.fields;
}

/**
 * `fields` with the stored `default` of every field resent without one
 * (same name, kind and — for a list — binding and list type). Pure.
 *
 * @returns the fields to write and the names whose default was kept.
 */
export function keepStoredDefaults(
  fields: readonly ModuleField[],
  stored: readonly ModuleField[],
): { fields: ModuleField[]; kept: string[] } {
  const byName = new Map(stored.map((f) => [f.name, f]));
  const kept: string[] = [];
  const out = fields.map((f) => {
    if ("default" in f && f.default !== undefined) return f;
    const prev = byName.get(f.name);
    if (!prev || prev.kind !== f.kind || !("default" in prev) || prev.default === undefined) {
      return f;
    }
    // A list's default takes the shape of its binding (entries vs a
    // `caelo:list/<id>`) and of its list type (a `texts` entry is not a
    // `links` entry): a rebound or retyped list starts without one.
    if (
      f.kind === "list" &&
      prev.kind === "list" &&
      (bindOf(prev) !== bindOf(f) || prev.listType !== f.listType)
    ) {
      return f;
    }
    kept.push(f.name);
    return { ...f, default: prev.default } as ModuleField;
  });
  return { fields: out, kept };
}

function bindOf(f: Extract<ModuleField, { kind: "list" }>): string {
  return f.bind ?? "local";
}
