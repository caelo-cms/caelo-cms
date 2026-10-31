// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin dependencies (`requiresPlugins` in the manifest).
 *
 * A plugin that requires another runs only while that one is active: the
 * activation ops refuse until every required plugin is active, the disable
 * and uninstall paths refuse while an active plugin requires the target,
 * and the loader refuses to load a plugin whose dependency is not active
 * (recorded as a load failure — the host never changes a plugin's status,
 * CLAUDE.md §2 #1008).
 *
 * "Active" is the Owner's decision on the `plugins` row, not whether the
 * dependency happens to be loaded on this instance: a dependency that is
 * active but failing to load is its own health problem, shown on it.
 *
 * The helpers read `plugins` through the caller's transaction, so an
 * activation and the check it depends on see the same rows.
 */

import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The `requiresPlugins` of a stored manifest (the `manifest_json` jsonb). */
export function requiredPluginsOf(manifestJson: unknown): string[] {
  const raw = (manifestJson as { requiresPlugins?: unknown } | null)?.requiresPlugins;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

/** One required plugin that is not active, and what it is instead. */
export interface InactiveRequirement {
  readonly slug: string;
  /** The row's status, or `"not installed"` when there is no row. */
  readonly status: string;
}

/**
 * The plugins among `required` that are not active.
 *
 * @returns in the order `required` lists them; empty when all are active.
 */
export async function inactiveRequiredPlugins(
  tx: TransactionRunner,
  required: ReadonlyArray<string>,
): Promise<InactiveRequirement[]> {
  if (required.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT slug, status FROM plugins
    WHERE slug = ANY(${textArray(required)})
  `)) as unknown as { slug: string; status: string }[];
  const status = new Map(rows.map((r) => [r.slug, r.status]));
  return required
    .filter((slug) => status.get(slug) !== "active")
    .map((slug) => ({ slug, status: status.get(slug) ?? "not installed" }));
}

/**
 * The active plugins (other than `slug` itself) whose manifest requires `slug`.
 *
 * @returns slugs, sorted.
 */
export async function activeDependentsOf(tx: TransactionRunner, slug: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT slug FROM plugins
    WHERE status = 'active'
      AND slug <> ${slug}
      AND manifest_json -> 'requiresPlugins' @> jsonb_build_array(${slug}::text)
    ORDER BY slug
  `)) as unknown as { slug: string }[];
  return rows.map((r) => r.slug);
}

/**
 * Why `slug` cannot be activated yet, worded as the next step to take.
 *
 * @example
 *   requirementsMessage("ratings", [{ slug: "consent-manager", status: "awaiting_activation" }])
 *   // 'plugin "ratings" requires "consent-manager" (awaiting_activation). Activate
 *   //  "consent-manager" first (activate_plugin with slug "consent-manager"), then activate "ratings".'
 */
export function requirementsMessage(
  slug: string,
  missing: ReadonlyArray<InactiveRequirement>,
): string {
  const list = missing.map((m) => `"${m.slug}" (${m.status})`).join(", ");
  const first = missing[0]?.slug ?? "";
  const notInstalled = missing.filter((m) => m.status === "not installed");
  const next =
    notInstalled.length === missing.length
      ? `Install ${missing.map((m) => `"${m.slug}"`).join(", ")} first; "${slug}" cannot run without it.`
      : `Activate "${first}" first (activate_plugin with slug "${first}"), then activate "${slug}".`;
  return `plugin "${slug}" requires ${list}. ${next}`;
}

/**
 * Why `slug` cannot be switched off or removed while `dependents` run.
 *
 * @param action what was attempted, e.g. "disabled" or "uninstalled".
 */
export function dependentsMessage(
  slug: string,
  dependents: ReadonlyArray<string>,
  action: "disabled" | "uninstalled",
): string {
  const list = dependents.map((d) => `"${d}"`).join(", ");
  return `plugin "${slug}" cannot be ${action} while ${list} ${dependents.length === 1 ? "requires" : "require"} it. Disable ${list} first, then ${action === "disabled" ? "disable" : "uninstall"} "${slug}".`;
}
