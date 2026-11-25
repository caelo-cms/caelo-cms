# Several installs on one Postgres server

Issue #1689, part of epic #1692. Postgres role names are server-wide, and every Caelo install names six roles and three databases. Until #1689 those were fixed (`admin_role`, `cms_admin`, …), so each install needed a Postgres server of its own. The smallest Cloud SQL server is the largest fixed cost of an idle install. This page explains how several installs share one server and keep the isolation CLAUDE.md §2 asks for.

## The name map

Each install has one map of its role and database names (`@caelo-cms/shared` `install-names.ts`):

| Slot | Default | What it is |
|---|---|---|
| `roles.admin` | `admin_role` | authoring and migration login |
| `roles.public` | `public_role` | the live gateway's only login |
| `roles.publicStaging` | `public_staging_role` | the staging gateway's only login (#1329) |
| `roles.operatorAccessReader` | `operator_access_reader` | NOLOGIN role of the operator-access sync job |
| `roles.platformUpdater` | `platform_updater` | NOLOGIN role of the upgrader job and the update agent |
| `roles.formerGateway` | `gateway_role` | the gateway's former cms_admin login (#635), so migrations that strip an old one never touch another install's |
| `databases.admin` | `cms_admin` | the authoring database |
| `databases.public` | `cms_public` | the live site's public database |
| `databases.publicStaging` | `cms_public_staging` | the staging site's public database |

Every process of the install reads it from `CAELO_INSTALL_NAMES` (JSON, every slot set). Unset means the defaults: an install from before #1689 changes nothing. A map that is set is validated in full: plain lower-case identifiers, at most 63 characters, all different, none starting with `pg_`, `cloudsql`, `rds_`, `rdsadmin` or `azure_`, and none a Postgres keyword that would need quoting (`select`, `user`, `left`, …: `POSTGRES_KEYWORDS_NEEDING_QUOTES`, which bootstrap.sh checks against the server's own `pg_get_keywords()`), because every name is spliced unquoted into the SQL. No role may be called `public`: Postgres reserves it for the PUBLIC pseudo-role. A partial map is refused, never mixed with the defaults. `prefixedInstallNames("t1")` builds the map `t1_admin_role`, `t1_cms_admin`, … that the tests use.

Logical database names (`database: "cms_admin"` in an op definition, `publicDatabase: "cms_public_staging"` on an adapter) only choose a pool. They never reach Postgres and stay as they are. The physical name is in each pool's URL.

## Who reads the map

- **Migrations.** The committed files are written with the default names. The runner renames every whole-word occurrence to the install's name before it runs a file (`runner.ts` `installNameTokens` / `renameForInstall`), so no file changes. The staging run also retargets `public_role` to the staging login, which is the #1329 swap, generalised. `migrate.ts` refuses a URL that reaches another database than the install's.
- **Role audit** (`role-audit.ts`, after every migration run): every rule uses the install's names. Two rules are new; see below.
- **Query API adapter.** `verifyRoles` checks each pool against the install's roles and physical databases (`AdapterConfig.names`, default: the process's map). `adapter.installNames` is what everything else that writes a role name takes.
- **Plugin schema DDL** (plugin-sandbox `publicGrantTargets`, `adminGrantTarget`): the emitters require a target built from the install's roles; there is no default. The plugin host builds it from `adapter.installNames`, so a plugin of install B grants to B's roles only.
- **API gateway** (`database-env.ts`): its own URL must name the install's login and database. A value naming the install's admin database or roles, or the default ones, is refused. `CAELO_INSTALL_NAMES` is the one database-ish value it accepts, once it parses.
- **Diagnostics** (`diagnostics.database_activity`): lists sessions of the install's own databases only, never another install's.
- **The in-cloud jobs' URLs** (`cloudSqlIamDatabaseUrls`) and the self-hosted update agent: the install's database names.
- **`caelo_grant_platform_updater(updater, admin_database, public_database)`** (cms_admin 0780) takes the names as arguments. A template copy keeps function bodies verbatim, and 0270's version named the roles in its body. 0270's argument-less version stays for one release as a wrapper that passes the install's names, because the previous release's self-hosted convergence calls it (migrations are expand-only, RELEASING.md); a later release drops it (#1722). A template copy drops the wrapper (`DROP_IN_COPY_SQL`), since its body names the template and no older release's convergence runs against a copy.

## Isolation between installs

The database enforces it; nothing relies on names being guessed right.

- **CONNECT.** Every install database is closed to `PUBLIC` and opened to the install's own roles only (bootstrap.sh, migrations 0278 and 0530, the template copy). A new database accepts no connection before it is closed (`ALLOW_CONNECTIONS false` until then), so no other install's login gets in between and stays.
- **Names of someone else.** bootstrap.sh with a map stops before its first statement when a name of the map already belongs to someone else on the server: a role that is a superuser or may connect to a private database outside the map, a database the map's admin role does not own, or any existing role in the `formerGateway` slot. Its statements would alter that role, open the map's databases to it, or (`DROP OWNED BY`, the former gateway's cleanup, which runs only with the default names) revoke that role's CONNECT on its own install's databases. The template copy refuses any name that exists.
- **Connection limits.** The gateway logins carry `CONNECTION LIMIT 30` as before. On a shared server, also bound the admin login: `ADMIN_ROLE_CONNECTION_LIMIT` for bootstrap.sh, `adminConnectionLimit` for the template copy. Otherwise one install can take every connection the server has. Size the limit to the install's connection budget ([connection-budget.md](./connection-budget.md)): every admin instance's pools and LISTEN connection, plus up to 8 for a migration run (`migrate.ts` opens at most two connections per pool, and its last step holds four pools: its own and the projection's three).
- **Role audit, cross-install CONNECT** (`crossInstallConnectSql`). No role of the install, and no member of one, may connect to another install's database, neither itself nor through any role it belongs to. A membership counts with or without INHERIT: `SET ROLE` reaches the other role's privileges either way, and a database grant lives in the shared catalog. The audit does not decide by name what "another install's" is. It looks for a database that is neither this install's, nor open to every login, nor one of the server's own (`SERVER_DATABASES`: `postgres`, `template0`, `template1`, and `cloudsqladmin`, `rdsadmin`, `azure_maintenance`, `azure_sys` of the managed services, which may restrict those to the group an install's admin role belongs to). Only another install, or another tenant of the server, has such a database. So the rule holds for any naming scheme, and an install alone on its server sees no change.
- **Role audit, foreign references** (`foreignReferencesSql`, run on each of the install's databases). Nothing in the database may be owned by, granted to, or named in a policy of another install's role. That means a role that is not the install's, not a member of one, not a superuser, and may connect to another private database. It reads `pg_shdepend`, which records every owner, privilege, policy and initial privilege for every role but the bootstrap superuser. No object kind is missed because someone forgot it. It also checks the database's own ACL and owner.
- **Gateway boot probe** (`databaseIsolationProblems`). The gateway's login may connect to no database but its own: not cms_admin, not the other environment's, not any other private database on the server but the server's own.
- **Adversarial test** (`packages/admin-core/src/__tests__/shared-postgres.integration.test.ts`). The test runs two installs on one CI server and checks each login of A against each database of B and the reverse (connect refused, so no read or write), `SET ROLE` across installs, a plugin provisioned for B, and a deliberate cross-install grant, CONNECT and policy, which the audit must refuse.

Postgres has no cross-database query without a bridge (`dblink`, `postgres_fdw`), and the audit already refuses those (#635). So "cannot connect" means "cannot read or write".

## Fast creation from a template

Fresh bootstrap plus every migration takes 15–90 s. Copying a template install and rebinding it takes 2.6–7 s (caelo-hosting `docs/measurements.md`). `packages/migrations/src/install-from-template.ts` is the CLI. It ships in the admin image next to `migrate.ts`:

```sh
CAELO_SUPERUSER_DATABASE_URL=postgres://<superuser>@<host>/postgres?sslmode=verify-full \
CAELO_TEMPLATE_INSTALL_NAMES='<the template map>' \
CAELO_INSTALL_NAMES='<the new install map>' \
ADMIN_ROLE_PASSWORD=… PUBLIC_ROLE_PASSWORD=… PUBLIC_STAGING_ROLE_PASSWORD=… \
ADMIN_ROLE_CONNECTION_LIMIT=20 \
bun run packages/migrations/src/install-from-template.ts
```

Then run the new install's migrations as usual, with its `CAELO_INSTALL_NAMES`. They apply only what the template does not have yet, and every audit runs.

**The template** is an install like any other: bootstrapped with its own map (`CAELO_INSTALL_NAMES=… bootstrap.sh`) and migrated, but never booted. Nothing install-specific lives in it: no Owner, no content. Migrations do draw a few signing keys at random (the gateways' cookie secrets, the unsubscribe-link keys, the IndexNow key); the copy draws each of them anew (step 5). Keep every session off it while copies run: `CREATE DATABASE … TEMPLATE` refuses a template with other sessions. Migrate the template to each new release so copies start current.

**What a copy does** (`template-install.ts`):

1. It creates the new roles with the template roles' attributes (login, inherit, connection limit, settings) and the memberships between them. It never adds SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS.
2. It runs `CHECKPOINT`, because a copy of a database with dirty buffers is up to 15× slower. Then it runs `CREATE DATABASE … TEMPLATE … OWNER <new admin>` for each database, with the default WAL_LOG strategy (FILE_COPY measured slower). Each copy is created with `ALLOW_CONNECTIONS false`, closed to `PUBLIC`, and only then opened: a new database lets every login connect until PUBLIC's CONNECT is revoked, and a REVOKE ends no session that got in before it. bootstrap.sh creates an install's databases the same way.
3. It drops the previous release's shims whose body names the template (`DROP_IN_COPY_SQL`: the argument-less `caelo_grant_platform_updater()`), then rebinds each copy object by object (`template-rebind.ts`): `ALTER … OWNER TO` for schemas, tables, views, sequences, types, routines, statistics and event triggers; `ALTER POLICY … TO`; and for each privilege a template role held, a GRANT to the new role and a REVOKE from the old one.
4. It grants the template databases' database-level privileges to the new roles and applies the template's per-database settings (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`). Neither is part of a copy: they live in shared catalogs keyed by the database's OID.
5. It draws every value a migration drew at random for the template anew (`template-secrets.ts` `INSTALL_SECRETS`) and republishes the gateways' projection from the copy, so no two installs share a signing key and the copy's public databases never serve the template's. `template-secrets.test.ts` scans every migration for a random draw and fails unless it is listed there or explained as no secret: a migration that seeds a new secret must add it to the list.
6. It refuses the result while anything still names the template. It checks `pg_shdepend` for template roles and function bodies for the template's names, then runs the full role audit for the new install. A failed copy is removed (its databases, then its roles). A copy never touches a database or role that already existed: a name that exists stops it before it creates anything.

**What the rebind avoids.** These are the traps from the measurements:

- `REASSIGN OWNED BY` also moves shared objects, the template databases themselves. Two copies at once then fail with `tuple concurrently updated`, and one is left half rebound. The rebind runs `ALTER … OWNER TO` inside each copy, which touches only that copy's catalog. Two copies at once both succeed; the test runs them that way.
- `DROP OWNED BY` also revokes the template roles' CONNECT on the template databases, and it drops policies that name only those roles.
- An extension the template's admin role owns cannot be moved: `ALTER EXTENSION` has no `OWNER TO`. bootstrap.sh therefore creates `pg_trgm` as the superuser. A template made before this keeps the admin role's `pg_trgm`, and the copy refuses it with that reason.

The copy needs a superuser of the server, the provider's own and never an install's: it creates roles and databases and changes owners of objects it does not own. A managed service without a superuser (Cloud SQL) needs another setup. There, install roles must not be Admin API users, because every Admin API user is a member of `cloudsqlsuperuser`, which owns every Admin API database, and that crosses installs. The cross-install CONNECT rule of the role audit fails on exactly that state.

## Adding something that names a role or database

- In a migration: write today's name. The runner renames it. Never compute it from `current_user`.
- In a SQL function body: take the name as an argument (cms_admin 0780), never a literal. A template copy keeps the body verbatim, and the copy refuses a body that names the template's roles.
- In TypeScript: take it from the adapter's `installNames`, or from `installNamesFromEnv()` where there is no adapter. Never from a constant.
- In a new audit rule: use `role-audit.ts`'s builders, which take the map.
