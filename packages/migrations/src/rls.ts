// SPDX-License-Identifier: MPL-2.0

/**
 * RLS policy generator applied after every migration.
 *
 * Every table in both databases must have:
 *   - ENABLE ROW LEVEL SECURITY
 *   - FORCE ROW LEVEL SECURITY (so even the table owner is subject to policies)
 *   - at least one policy that references `current_setting('caelo.actor_id', true)`
 *     (cms_admin) or `current_setting('caelo.plugin_id', true)` (cms_public)
 *
 * A NULL / empty session setting yields no matching rows — fail closed.
 */

export type RlsScope =
  | { kind: "per_actor_row"; actorIdColumn: string; systemBypass: boolean }
  | { kind: "per_plugin_row"; pluginIdColumn: string };

export interface RlsSpec {
  table: string;
  scope: RlsScope;
}

export function buildRlsSql(specs: readonly RlsSpec[]): string {
  const statements: string[] = [];
  for (const spec of specs) {
    statements.push(`ALTER TABLE ${spec.table} ENABLE ROW LEVEL SECURITY;`);
    statements.push(`ALTER TABLE ${spec.table} FORCE ROW LEVEL SECURITY;`);

    if (spec.scope.kind === "per_actor_row") {
      const systemBypass = spec.scope.systemBypass
        ? "OR current_setting('caelo.actor_kind', true) = 'system'"
        : "";
      statements.push(
        `DROP POLICY IF EXISTS ${spec.table}_actor_scope ON ${spec.table};`,
        `CREATE POLICY ${spec.table}_actor_scope ON ${spec.table}`,
        `  USING (${spec.scope.actorIdColumn} = NULLIF(current_setting('caelo.actor_id', true), '')::uuid ${systemBypass})`,
        `  WITH CHECK (${spec.scope.actorIdColumn} = NULLIF(current_setting('caelo.actor_id', true), '')::uuid ${systemBypass});`,
      );
    } else {
      statements.push(
        `DROP POLICY IF EXISTS ${spec.table}_plugin_scope ON ${spec.table};`,
        `CREATE POLICY ${spec.table}_plugin_scope ON ${spec.table}`,
        `  USING (${spec.scope.pluginIdColumn} = NULLIF(current_setting('caelo.plugin_id', true), ''))`,
        `  WITH CHECK (${spec.scope.pluginIdColumn} = NULLIF(current_setting('caelo.plugin_id', true), ''));`,
      );
    }
  }
  return `${statements.join("\n")}\n`;
}

/** cms_admin table policies. */
export const CMS_ADMIN_RLS: readonly RlsSpec[] = [
  {
    table: "actors",
    // actors are self-owned: an actor row matches when its id equals the current actor.
    scope: { kind: "per_actor_row", actorIdColumn: "id", systemBypass: true },
  },
  {
    table: "audit_events",
    scope: { kind: "per_actor_row", actorIdColumn: "actor_id", systemBypass: true },
  },
];

/** cms_public table policies. */
export const CMS_PUBLIC_RLS: readonly RlsSpec[] = [
  {
    table: "rls_sentinel",
    scope: { kind: "per_plugin_row", pluginIdColumn: "plugin_id" },
  },
];

/** Grants applied in cms_public after schema creation so public_role can INSERT into declared plugin tables. */
export const CMS_PUBLIC_GRANTS_SQL = `
GRANT USAGE ON SCHEMA public TO public_role;
GRANT SELECT, INSERT ON rls_sentinel TO public_role;
`;
