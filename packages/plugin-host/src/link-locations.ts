// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the plugin hook of the link migration.
 *
 * Core converts literal internal links (`/about`) into references
 * (`caelo:page/<id>`) across its own content. Plugins store links too
 * (international-site's per-language chrome variants carry menu items),
 * and only the plugin knows where. The hook splits the work the same way
 * the other composition points do (#390, #592):
 *
 *   - the plugin's `linkLocationsOperation` NAMES the places (table, row,
 *     column, and how to read the value) — a read-only render
 *     invocation, so it cannot write;
 *   - core reads each named column, runs it through the one shared
 *     canonicaliser, and writes it back in the migration's transaction
 *     with the migration's snapshot (helpers below), so the plugin's data
 *     reverts with core's.
 *
 * Loud (CLAUDE.md §2): a failing hook, an ill-formed answer, or a
 * location outside the plugin's declared `adminSchema` throws — the
 * migration refuses rather than silently skipping a plugin's links.
 */

import { type PluginLinkLocation, pluginLinkLocations } from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import {
  type PluginRowRef,
  type PluginRowState,
  rowToState,
  withPluginScope,
} from "./row-snapshots.js";

/** One plugin's answer for one scope. */
export interface PluginLinkLocationSet {
  readonly pluginId: string;
  readonly pluginSlug: string;
  /** The plugin's private schema (`plugin_<slug>`). */
  readonly schema: string;
  readonly locations: readonly PluginLinkLocation[];
}

const LINK_COLUMN_TYPES = new Set(["jsonb", "text", "string"]);

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.linkLocationsOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The private schema a plugin's admin tables live in. */
export function pluginAdminSchemaName(slug: string): string {
  return `plugin_${slug.replace(/-/g, "_")}`;
}

/**
 * Ask every active plugin with a link hook where its links are, as seen
 * from `scope` (main, or one chat branch).
 */
export async function collectPluginLinkLocations(
  scope: RenderScope,
): Promise<PluginLinkLocationSet[]> {
  const out: PluginLinkLocationSet[] = [];
  for (const lp of contributors()) {
    const operationName = lp.definition.linkLocationsOperation as string;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: lp.slug,
      operationName,
      args: {},
    });
    if (!r.ok) {
      throw new Error(
        `link migration: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const parsed = pluginLinkLocations.safeParse(r.value);
    if (!parsed.success) {
      throw new Error(
        `link migration: plugin "${lp.slug}" returned invalid link locations: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const adminSchema = lp.definition.adminSchema ?? {};
    for (const loc of parsed.data.locations) {
      const columns = adminSchema[loc.table];
      if (!columns) {
        throw new Error(
          `link migration: plugin "${lp.slug}" named table "${loc.table}", which is not in its adminSchema`,
        );
      }
      const type = columns[loc.column];
      if (type === undefined || !LINK_COLUMN_TYPES.has(type)) {
        throw new Error(
          `link migration: plugin "${lp.slug}" named ${loc.table}.${loc.column}, which is not a declared jsonb or text column`,
        );
      }
    }
    out.push({
      pluginId: lp.pluginId,
      pluginSlug: lp.slug,
      schema: pluginAdminSchemaName(lp.slug),
      locations: parsed.data.locations,
    });
  }
  return out;
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function qualified(ref: PluginRowRef) {
  if (!IDENT_RE.test(ref.schema) || !IDENT_RE.test(ref.table)) {
    throw new Error(`link migration: refusing identifier ${ref.schema}.${ref.table}`);
  }
  return sql.raw(`"${ref.schema}"."${ref.table}"`);
}

function columnIdent(column: string) {
  if (!IDENT_RE.test(column) || column.startsWith("caelo_")) {
    throw new Error(`link migration: refusing column "${column}"`);
  }
  return sql.raw(`"${column}"`);
}

/**
 * The main-line state of one plugin row (live, not deleted, not created
 * on a branch), or null. Runs in the plugin's RLS scope.
 */
export async function readMainPluginRow(
  tx: TransactionRunner,
  ref: PluginRowRef,
): Promise<PluginRowState | null> {
  const target = qualified(ref);
  return withPluginScope(tx, ref.pluginId, async () => {
    const rows = (await tx.execute(sql`
      SELECT to_jsonb(t.*) AS row FROM ${target} AS t
      WHERE t.id = ${ref.rowId}::uuid
        AND t."caelo_chat_branch_id" IS NULL AND t."caelo_deleted_at" IS NULL
      FOR UPDATE
    `)) as unknown as { row: unknown }[];
    const raw = rows[0]?.row;
    if (raw === undefined) return null;
    const row = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
    return rowToState(row);
  });
}

/**
 * Write one column of a main-line plugin row (bumping its version) and
 * return the row's new state for the snapshot. The value is cast through
 * the table's own row type, so the column keeps its declared type.
 */
export async function writeMainPluginColumn(
  tx: TransactionRunner,
  ref: PluginRowRef,
  column: string,
  value: unknown,
): Promise<PluginRowState> {
  const target = qualified(ref);
  const col = columnIdent(column);
  return withPluginScope(tx, ref.pluginId, async () => {
    const rows = (await tx.execute(sql`
      UPDATE ${target} AS t
         SET ${col} = r.${col},
             "caelo_version" = t."caelo_version" + 1,
             "caelo_updated_at" = now()
        FROM jsonb_populate_record(NULL::${target}, (${JSON.stringify({ [column]: value })}::text)::jsonb) AS r
       WHERE t.id = ${ref.rowId}::uuid
      RETURNING to_jsonb(t.*) AS row
    `)) as unknown as { row: unknown }[];
    const raw = rows[0]?.row;
    if (raw === undefined) {
      throw new Error(
        `link migration: ${ref.schema}.${ref.table} ${ref.rowId} disappeared during the migration`,
      );
    }
    const row = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
    return rowToState(row);
  });
}
