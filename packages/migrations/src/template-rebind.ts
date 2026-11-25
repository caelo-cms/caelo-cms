// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — rebind one database copied from a template install to the
 * new install's roles, object by object.
 *
 * `CREATE DATABASE … TEMPLATE` copies every object with its owner and its
 * privileges, which name the TEMPLATE's roles (by OID). This module moves
 * each reference to the new install's role: owners (`ALTER … OWNER TO`),
 * row-level policies (`ALTER POLICY … TO`) and every privilege entry (a
 * GRANT to the new role, then a REVOKE from the template's). It runs
 * inside the copy only, as one server-side block, so it touches nothing of
 * the template and nothing another copy running at the same time touches.
 *
 * Two shortcuts are deliberately not used (measured on PostgreSQL 17,
 * caelo-hosting measurements.md §5):
 *
 *   - `REASSIGN OWNED BY` also moves SHARED objects the role owns — the
 *     template databases themselves — and two copies at once fail with
 *     `tuple concurrently updated` on those rows, leaving one copy half
 *     rebound.
 *   - `DROP OWNED BY` also revokes the template role's CONNECT on the
 *     template databases and drops policies that name only that role.
 *
 * Completeness is not assumed: {@link templateReferencesSql} lists every
 * `pg_shdepend` entry the copy still holds for a template role (any object
 * kind this block does not move — an extension the template's admin role
 * owns, default privileges, a large object) and the caller fails on any.
 */

/**
 * The rebind block. Reads the role map `{ "<template role>": "<new role>" }`
 * from the transaction setting {@link REBIND_MAP_SETTING}; every name is a
 * validated install name, quoted with `%I` all the same. Run as the
 * superuser, connected to the copy.
 */
export const REBIND_MAP_SETTING = "caelo.rebind_map";

export const REBIND_SQL = `
DO $caelo_rebind$
DECLARE
  m jsonb := current_setting('${REBIND_MAP_SETTING}')::jsonb;
  r record;
  roles text;
BEGIN
  -- 1. Owners. Tables first: ALTER TABLE moves the table's indexes, its
  -- TOAST table, its row type and the sequences its columns own with it.
  FOR r IN
    SELECT n.nspname, o.rolname AS old
      FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
     WHERE m ? o.rolname
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, m->>r.old);
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass::text AS obj, c.relkind, o.rolname AS old
      FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
     WHERE m ? o.rolname AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.obj, m->>r.old);
  END LOOP;
  -- Sequences no table column owns (the others moved with their table).
  FOR r IN
    SELECT c.oid::regclass::text AS obj, o.rolname AS old
      FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
     WHERE m ? o.rolname AND c.relkind = 'S'
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', r.obj, m->>r.old);
  END LOOP;
  -- Stand-alone composite types.
  FOR r IN
    SELECT c.reltype::regtype::text AS obj, o.rolname AS old
      FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
     WHERE m ? o.rolname AND c.relkind = 'c'
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', r.obj, m->>r.old);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure::text AS obj, p.prokind, o.rolname AS old
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE m ? o.rolname
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.prokind WHEN 'a' THEN 'AGGREGATE' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
      r.obj, m->>r.old);
  END LOOP;
  -- Domains, enums and ranges (a range's multirange and every array type
  -- move with their base type; table row types moved with their table).
  FOR r IN
    SELECT t.oid::regtype::text AS obj, t.typtype, o.rolname AS old
      FROM pg_type t JOIN pg_roles o ON o.oid = t.typowner
     WHERE m ? o.rolname AND t.typtype IN ('d', 'e', 'r')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.obj, m->>r.old);
  END LOOP;
  FOR r IN
    SELECT quote_ident(n.nspname) || '.' || quote_ident(s.stxname) AS obj, o.rolname AS old
      FROM pg_statistic_ext s
      JOIN pg_namespace n ON n.oid = s.stxnamespace
      JOIN pg_roles o ON o.oid = s.stxowner
     WHERE m ? o.rolname
  LOOP
    EXECUTE format('ALTER STATISTICS %s OWNER TO %I', r.obj, m->>r.old);
  END LOOP;
  FOR r IN
    SELECT e.evtname, o.rolname AS old
      FROM pg_event_trigger e JOIN pg_roles o ON o.oid = e.evtowner
     WHERE m ? o.rolname
  LOOP
    EXECUTE format('ALTER EVENT TRIGGER %I OWNER TO %I', r.evtname, m->>r.old);
  END LOOP;

  -- 2. Row-level policies: every template role in a policy's role list
  -- becomes the new install's, PUBLIC and other roles stay as they are.
  FOR r IN
    SELECT p.polname, p.polrelid::regclass::text AS tbl, p.polroles
      FROM pg_policy p
     WHERE EXISTS (SELECT 1 FROM unnest(p.polroles) u(oid)
                     JOIN pg_roles g ON g.oid = u.oid WHERE m ? g.rolname)
  LOOP
    SELECT string_agg(
             CASE WHEN u.oid = 0 THEN 'PUBLIC'
                  ELSE quote_ident(coalesce(m->>g.rolname, g.rolname)) END,
             ', ' ORDER BY u.ord)
      INTO roles
      FROM unnest(r.polroles) WITH ORDINALITY u(oid, ord)
      LEFT JOIN pg_roles g ON g.oid = u.oid;
    EXECUTE format('ALTER POLICY %I ON %s TO %s', r.polname, r.tbl, roles);
  END LOOP;

  -- 3. Privileges the template's roles hold (the owners' own entries were
  -- rewritten by ALTER … OWNER TO): the same privilege to the new role,
  -- with its grant option, then off the template's.
  FOR r IN
    SELECT 'TABLE' AS kind, c.oid::regclass::text AS obj, NULL::text AS col,
           a.privilege_type AS priv, a.is_grantable, g.rolname AS old
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND m ? g.rolname
    UNION ALL
    SELECT 'SEQUENCE', c.oid::regclass::text, NULL, a.privilege_type, a.is_grantable, g.rolname
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE c.relkind = 'S' AND m ? g.rolname
    UNION ALL
    SELECT 'COLUMN', att.attrelid::regclass::text, att.attname::text, a.privilege_type,
           a.is_grantable, g.rolname
      FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE att.attacl IS NOT NULL AND m ? g.rolname
    UNION ALL
    SELECT 'SCHEMA', quote_ident(n.nspname), NULL, a.privilege_type, a.is_grantable, g.rolname
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE m ? g.rolname
    UNION ALL
    SELECT 'ROUTINE', p.oid::regprocedure::text, NULL, a.privilege_type, a.is_grantable, g.rolname
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE m ? g.rolname
    UNION ALL
    SELECT CASE WHEN t.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END, t.oid::regtype::text, NULL,
           a.privilege_type, a.is_grantable, g.rolname
      FROM pg_type t CROSS JOIN LATERAL aclexplode(t.typacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE m ? g.rolname
    UNION ALL
    SELECT 'LANGUAGE', quote_ident(l.lanname), NULL, a.privilege_type, a.is_grantable, g.rolname
      FROM pg_language l CROSS JOIN LATERAL aclexplode(l.lanacl) a
      JOIN pg_roles g ON g.oid = a.grantee
     WHERE m ? g.rolname
  LOOP
    IF r.kind = 'COLUMN' THEN
      EXECUTE format('GRANT %s (%I) ON TABLE %s TO %I%s', r.priv, r.col, r.obj, m->>r.old,
        CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %I', r.priv, r.col, r.obj, r.old);
    ELSE
      EXECUTE format('GRANT %s ON %s %s TO %I%s', r.priv, r.kind, r.obj, m->>r.old,
        CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s ON %s %s FROM %I', r.priv, r.kind, r.obj, r.old);
    END IF;
  END LOOP;
END
$caelo_rebind$;
`;

/**
 * Every reference the current database still holds to one of `roles`, as
 * `<role> <how> <object>`: an owner, a privilege, a policy or an initial
 * privilege (`pg_shdepend`, which records them all), plus default
 * privileges. Empty after a complete rebind. `roles` are validated install
 * names.
 */
export function templateReferencesSql(roles: readonly string[]): string {
  for (const r of roles) {
    if (!/^[a-z_][a-z0-9_]*$/.test(r)) throw new Error(`"${r}" is not a role name`);
  }
  const list = roles.map((r) => `'${r}'`).join(", ");
  return `
SELECT g.rolname::text || ' ' ||
       CASE d.deptype WHEN 'o' THEN 'owns' WHEN 'a' THEN 'holds a privilege on'
                      WHEN 'r' THEN 'is named by' WHEN 'i' THEN 'holds an initial privilege on'
                      ELSE 'is referenced by' END || ' ' ||
       pg_describe_object(d.classid, d.objid, d.objsubid) AS reference
  FROM pg_shdepend d
  JOIN pg_roles g ON g.oid = d.refobjid AND d.refclassid = 'pg_authid'::regclass
 WHERE d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND g.rolname IN (${list})
UNION ALL
SELECT g.rolname::text || ' has default privileges in this database'
  FROM pg_default_acl a JOIN pg_roles g ON g.oid = a.defaclrole
 WHERE g.rolname IN (${list})
ORDER BY 1
`;
}

/**
 * Functions whose body names one of `names` (the template's role and
 * database names) as a whole word: their text is copied verbatim, so the
 * copy would act on the TEMPLATE's roles when it runs them (#1689 is why
 * cms_admin 0780 took those names out of `caelo_grant_platform_updater`).
 */
export function staleFunctionBodiesSql(names: readonly string[]): string {
  for (const n of names) {
    if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error(`"${n}" is not a role or database name`);
  }
  const word = `(^|[^A-Za-z0-9_$])(${names.join("|")})([^A-Za-z0-9_$]|$)`;
  return `
SELECT p.oid::regprocedure::text AS routine
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.prosrc ~ '${word}'
 ORDER BY 1
`;
}
