// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin schema provisioning that several admin instances can run at once
 * (issue #1008).
 *
 * Every admin instance provisions the schemas of its active plugins when it
 * boots. The emitted DDL is IF NOT EXISTS guarded, but that guard is not a
 * lock: two transactions that both see "no such schema" both insert it, and
 * the loser fails with 23505 on `pg_namespace_nspname_index`. On 2026-10-22
 * four Cloud Run instances booted in the same second and exactly that took
 * a live plugin down.
 *
 * So provisioning, per schema and per database:
 *   1. takes a transaction-scoped advisory lock on the schema name, which
 *      serialises every instance provisioning the same schema;
 *   2. skips the DDL when `plugin_schema_provisions` already holds the
 *      digest of this exact SQL and the schema still exists — the common
 *      boot case, which then takes no table lock at all (re-running
 *      DROP/CREATE POLICY would take ACCESS EXCLUSIVE on live tables);
 *   3. otherwise runs the DDL and records the digest in the same
 *      transaction, so a rolled-back provisioning leaves no record behind.
 *
 * A changed spec (new column, new table, a different plugin id in the RLS
 * policies) changes the digest, so evolution still runs: added columns are
 * created and columns the spec no longer declares are dropped (#1146) and
 * returned, so the adapter audits the drop.
 */

import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";

/**
 * The setting the emitted drop blocks record dropped columns in. Mirrors
 * `DROPPED_COLUMNS_SETTING` of plugin-sandbox's schema emitter (query-api
 * does not depend on the sandbox package).
 */
const DROPPED_COLUMNS_SETTING = "caelo.plugin_dropped_columns";

/** What one provisioning did. */
export interface ProvisionOutcome {
  readonly schemaName: string;
  /** `<table>.<column>` of every column dropped because the spec no longer declares it (#1146). */
  readonly droppedColumns: readonly string[];
}

/** The slice of a drizzle transaction this module needs. */
interface DdlTx {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Both emitters (`plugin-sandbox` `schemaFromSpec` / `adminSchemaFromSpec`)
 * open with exactly this statement. Anything else is not SQL we emitted.
 */
const SCHEMA_HEADER_RE = /^CREATE SCHEMA IF NOT EXISTS "(plugin_[a-z][a-z0-9_]*)";/;

/**
 * The plugin schema the emitted SQL creates.
 *
 * @throws when the SQL does not start with the emitters' CREATE SCHEMA
 *   statement — provisioning only ever runs DDL we emitted.
 */
export function provisionedSchemaName(caller: string, ddl: string): string {
  const name = SCHEMA_HEADER_RE.exec(ddl)?.[1];
  if (name === undefined) {
    throw new Error(
      `${caller}: the SQL does not start with CREATE SCHEMA IF NOT EXISTS "plugin_<slug>"; — pass the output of schemaFromSpec / adminSchemaFromSpec unchanged`,
    );
  }
  return name;
}

/**
 * Provision one plugin schema inside `tx` (see the module docblock).
 * Sets the `system` actor and the plugin id for the transaction.
 */
export async function provisionPluginSchemaInTx(
  tx: DdlTx,
  caller: string,
  opts: { pluginId: string; sql: string; journal?: boolean },
): Promise<ProvisionOutcome> {
  const schemaName = provisionedSchemaName(caller, opts.sql);
  const digest = createHash("sha256").update(opts.sql).digest("hex");
  await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
  await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${opts.pluginId}, true)`);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`caelo:plugin-schema:${schemaName}`}, 0))`,
  );
  const recorded = (await tx.execute(sql`
    SELECT 1 FROM plugin_schema_provisions
    WHERE schema_name = ${schemaName} AND sql_digest = ${digest}
      AND to_regnamespace(${schemaName}) IS NOT NULL
  `)) as unknown[];
  if (recorded.length > 0) return { schemaName, droppedColumns: [] };
  await tx.execute(sql.raw(opts.sql));
  // #1146 — the emitted DDL drops columns the spec no longer declares and
  // lists them in this transaction-local setting (plugin-sandbox schema.ts).
  const dropped = (await tx.execute(
    sql.raw(`SELECT coalesce(current_setting('${DROPPED_COLUMNS_SETTING}', true), '') AS v`),
  )) as unknown as Array<{ v: string }>;
  // #1267 — every table of a plugin's cms_admin schema writes the change
  // journal (kind `plugin_storage`, keyed on the plugin id); re-attached on
  // every new digest so a table a new version adds is journaled too.
  if (opts.journal === true) {
    await tx.execute(
      sql`SELECT caelo_journal_attach_plugin_schema(${schemaName}, ${opts.pluginId}::uuid)`,
    );
  }
  await tx.execute(sql`
    INSERT INTO plugin_schema_provisions (schema_name, sql_digest)
    VALUES (${schemaName}, ${digest})
    ON CONFLICT (schema_name) DO UPDATE
      SET sql_digest = EXCLUDED.sql_digest, provisioned_at = now()
  `);
  return {
    schemaName,
    droppedColumns: (dropped[0]?.v ?? "").split(",").filter((c) => c.length > 0),
  };
}
