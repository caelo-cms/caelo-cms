// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the `pluginAccess` marker of the operations a plugin may call
 * (docs/dev/external-plugin-brokers.md §7.1, decision Q9): what each
 * package's registry test checks, and how an approval card describes a
 * plugin's `cms_admin` allowlist.
 */

import { type AnyOperationDefinition, isReadOperation, type PluginAccess } from "./operation.js";
import type { OperationRegistry } from "./registry.js";

/** The marker an operation declares, or null when it declares none. */
export function pluginAccessOf(op: AnyOperationDefinition<unknown, unknown>): PluginAccess | null {
  return op.pluginAccess ?? null;
}

/** Whether an operation admits actor kind `plugin`. */
export function admitsPlugins(op: AnyOperationDefinition<unknown, unknown>): boolean {
  return op.actorScope.includes("plugin");
}

/**
 * The registry's operations whose marker is wrong, as messages naming the
 * fix: an op that admits `plugin` without `pluginAccess`, one that declares
 * it without admitting `plugin`, and a read operation marked `write`.
 */
export function pluginAccessProblems(registry: OperationRegistry): string[] {
  const problems: string[] = [];
  for (const name of registry.names()) {
    const found = registry.lookup(name);
    if (!found.ok) continue;
    const op = found.value;
    const access = pluginAccessOf(op);
    if (admitsPlugins(op) && access === null) {
      problems.push(
        `${name} admits actor kind "plugin" but declares no pluginAccess — add pluginAccess: "read" | "write" | "handle" (packages/query-api/src/operation.ts)`,
      );
    } else if (!admitsPlugins(op) && access !== null) {
      problems.push(
        `${name} declares pluginAccess but its actorScope does not admit "plugin" — remove the marker or admit plugins`,
      );
    } else if (isReadOperation(op) && access === "write") {
      problems.push(`${name} is a read operation and cannot be marked pluginAccess "write"`);
    }
  }
  return problems;
}

/** One domain of a `cms_admin` allowlist, as an approval card shows it. */
export interface PluginOperationGroup {
  /** The part of the operation names before the dot (`pages`, `lists`). */
  readonly domain: string;
  /** Operations that only read. */
  readonly reads: readonly string[];
  /** Operations that change core data. */
  readonly writes: readonly string[];
  /**
   * Names no plugin can call: not registered, not open to plugins, or
   * backing a plugin handle. The broker refuses them; the card says so.
   */
  readonly unavailable: readonly string[];
}

/**
 * A `cms_admin` allowlist grouped by domain and by read or write, from the
 * markers of the registry the host runs, for the Owner's review.
 */
export function describePluginOperations(
  registry: OperationRegistry,
  operations: readonly string[],
): PluginOperationGroup[] {
  const groups = new Map<string, { reads: string[]; writes: string[]; unavailable: string[] }>();
  for (const name of [...new Set(operations)].sort()) {
    const domain = name.split(".")[0] ?? name;
    const group = groups.get(domain) ?? { reads: [], writes: [], unavailable: [] };
    groups.set(domain, group);
    const found = registry.lookup(name);
    const access = found.ok && admitsPlugins(found.value) ? pluginAccessOf(found.value) : null;
    if (access === "read") group.reads.push(name);
    else if (access === "write") group.writes.push(name);
    else group.unavailable.push(name);
  }
  return [...groups.entries()].map(([domain, g]) => ({ domain, ...g }));
}

/**
 * Why a plugin's `cms_admin` allowlist cannot be approved as written, or
 * null when every name is an operation a plugin's `ctx.cms` can call (#1729
 * §7.1): each name the broker would refuse at call time — not registered,
 * not open to plugins, or backing one of the plugin's own handles — with
 * what to do instead. Staging, approval and finalization refuse such an
 * allowlist, so the Owner never approves a grant that cannot work.
 */
export function pluginOperationAllowlistRefusal(
  registry: OperationRegistry,
  operations: readonly string[],
): string | null {
  const unknown: string[] = [];
  const closed: string[] = [];
  const handles: string[] = [];
  for (const name of [...new Set(operations)].sort()) {
    const found = registry.lookup(name);
    if (!found.ok) unknown.push(name);
    else if (!admitsPlugins(found.value)) closed.push(name);
    else if (pluginAccessOf(found.value) === "handle") handles.push(name);
  }
  if (unknown.length + closed.length + handles.length === 0) return null;
  const parts = [
    unknown.length > 0
      ? `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an operation of this site`
      : null,
    closed.length > 0
      ? `${closed.join(", ")} ${closed.length === 1 ? "is" : "are"} not open to plugins`
      : null,
    handles.length > 0
      ? `${handles.join(", ")} ${handles.length === 1 ? "backs" : "back"} a plugin handle (call it through ctx.adminQuery, ctx.query, ctx.changes or ctx.config instead)`
      : null,
  ].filter((p): p is string => p !== null);
  return `capabilityConstraints.cms_admin.operations names operations a plugin cannot call: ${parts.join("; ")}. Remove them from the allowlist and submit the package again — a plugin can call exactly the operations whose actorScope admits "plugin" (read or write).`;
}
