// SPDX-License-Identifier: MPL-2.0

/**
 * The staging inbox is cleared at every Stage (issue #1329, epic #763 E10).
 *
 * On staging, an inbox table (a plugin table of kind `inbox`: new comments,
 * single votes, form submissions, newsletter sign-ups) holds what the team
 * and the reviewers sent while testing the staged site. It is test data:
 * never taken into the admin, and gone with the next Stage, so each Stage
 * starts from what the release publishes, not from the last round of
 * tests. Visitor-state tables (test accounts, sessions, a test voter's
 * earlier vote) are kept: a reviewer stays signed in across Stages.
 *
 * Runs on the admin's adapter on cms_public_staging only; the live
 * database is never touched. Identifiers come from the loaded plugins'
 * verified definitions and are checked before they reach SQL.
 */

import { loadedPlugins } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "staging-inbox",
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** One inbox table of a loaded plugin. */
export interface InboxTable {
  readonly pluginId: string;
  readonly schema: string;
  readonly table: string;
}

/** Every inbox table of the plugins this admin loaded. */
export function loadedInboxTables(): InboxTable[] {
  const out: InboxTable[] = [];
  for (const p of loadedPlugins.all()) {
    if (!SLUG_RE.test(p.slug)) throw new Error(`staging inbox: invalid plugin slug "${p.slug}"`);
    for (const [table, kind] of Object.entries(p.definition.tableKinds ?? {})) {
      if (kind !== "inbox") continue;
      if (!IDENT_RE.test(table)) throw new Error(`staging inbox: invalid table "${table}"`);
      out.push({ pluginId: p.pluginId, schema: `plugin_${p.slug.replace(/-/g, "_")}`, table });
    }
  }
  return out;
}

/**
 * Delete every row of `tables` in the staging database, each table under
 * its own plugin's RLS scope. A table not provisioned yet is skipped (the
 * next load creates it empty).
 *
 * @returns the `schema.table` names cleared.
 */
export async function clearStagingInbox(
  stagingAdapter: DatabaseAdapter,
  tables: readonly InboxTable[] = loadedInboxTables(),
): Promise<string[]> {
  const cleared: string[] = [];
  for (const t of tables) {
    await stagingAdapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
      const exists = (await tx.execute(
        sql`SELECT to_regclass(${`"${t.schema}"."${t.table}"`}) IS NOT NULL AS ok`,
      )) as unknown as { ok: boolean }[];
      if (!exists[0]?.ok) return;
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${t.pluginId}, true)`);
      await tx.execute(sql.raw(`DELETE FROM "${t.schema}"."${t.table}"`));
      cleared.push(`${t.schema}.${t.table}`);
    });
  }
  return cleared;
}
