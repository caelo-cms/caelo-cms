// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext, Result } from "@caelo-cms/shared";
import { err } from "@caelo-cms/shared";
// `import type` is erased at compile time — never hits the bundler, so
// no stub package needed in node_modules/bun. The runtime constructor
// comes from globalThis.Bun (defined under Bun's runtime). SvelteKit's
// vite/rollup chain previously inlined a build-time stub from
// node_modules/bun, which crashed at runtime; reading from globalThis
// sidesteps the entire bundling-vs-externalize fight.
import type { SQL as SQLType } from "bun";

type SQL = SQLType;
/** Subset of `Bun.SQL.Options` we set explicitly. `max` caps the pool size. */
interface PoolOptions {
  readonly max: number;
}
const SQL = (globalThis as { Bun?: { SQL: new (url: string, options?: PoolOptions) => SQLType } })
  .Bun?.SQL as unknown as new (
  url: string,
  options?: PoolOptions,
) => SQLType;

import { sql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { extractPgFields, isRlsDenial, OperationAbortError, type QueryError } from "./errors.js";
import type { OperationDefinition, TransactionRunner } from "./operation.js";

/**
 * Two connection pools per process — one per PostgreSQL role. Application code
 * never mixes roles in a single query. The admin pool targets `cms_admin` (the
 * authoring database, connected as `admin_role`); the public pool targets
 * `cms_public` and is expected to connect as either `public_role` (API
 * Gateway runtime path) or `admin_role` (admin-side reads of plugin data for
 * moderation + migrations).
 *
 * The adapter verifies role + database identity on first use via
 * `current_user` / `current_database()` — misconfiguration (e.g. a typo that
 * swaps the two URLs) fails loudly rather than allowing the RLS model to
 * silently misbehave.
 */
export interface AdapterConfig {
  readonly adminDatabaseUrl: string;
  readonly publicDatabaseUrl: string;
  /** Disable the startup self-check. Only for tests that deliberately assert it triggers. */
  readonly skipRoleVerification?: boolean;
  /**
   * Max connections per pool (the admin + public pools are sized separately,
   * each gets this `max`). Precedence: this option > `CAELO_DB_POOL_MAX` env >
   * Bun's default (10). Left unset in production — the env is only ever set by
   * the test preload to bound the suite's footprint under `max_connections`.
   */
  readonly poolMax?: number;
}

/**
 * Resolve the per-pool `max` connection cap. Returns `undefined` when neither
 * the explicit option nor `CAELO_DB_POOL_MAX` is set, so the caller keeps the
 * original 1-arg `new SQL(url)` path and inherits Bun's default of 10 — making
 * this a no-op in production where neither knob is present.
 *
 * Per CLAUDE.md §2 (no silent fallbacks pre-1.0): a value that is *present* but
 * malformed or below the safe floor throws loudly rather than quietly picking a
 * default. The floor is 2 because a single-connection pool self-deadlocks any
 * path that needs a second concurrent checkout (e.g. `verifyRoles` probing while
 * an op opens a transaction, or a test firing concurrent `.begin()` calls).
 */
export function resolvePoolMax(explicit?: number): number | undefined {
  if (explicit !== undefined) return validatePoolMax(explicit, "poolMax option");
  const raw = process.env.CAELO_DB_POOL_MAX;
  if (raw === undefined || raw === "") return undefined;
  return validatePoolMax(Number(raw), "CAELO_DB_POOL_MAX");
}

function validatePoolMax(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(
      `${source} must be an integer >= 2 (got ${value}); ` +
        `1 self-deadlocks the pool. Leave it unset for the Bun default of 10.`,
    );
  }
  return value;
}

interface ConnectionIdentity {
  readonly user: string;
  readonly database: string;
}

export class DatabaseAdapter {
  readonly #admin: BunSQLDatabase;
  readonly #public: BunSQLDatabase;
  readonly #adminRaw: SQL;
  readonly #publicRaw: SQL;
  readonly #skipVerify: boolean;
  #verifyPromise: Promise<void> | null = null;

  constructor(config: AdapterConfig) {
    // When no pool cap is configured (the production case) keep the original
    // 1-arg construction so behaviour is byte-for-byte unchanged: Bun default 10.
    const poolMax = resolvePoolMax(config.poolMax);
    if (poolMax === undefined) {
      this.#adminRaw = new SQL(config.adminDatabaseUrl);
      this.#publicRaw = new SQL(config.publicDatabaseUrl);
    } else {
      this.#adminRaw = new SQL(config.adminDatabaseUrl, { max: poolMax });
      this.#publicRaw = new SQL(config.publicDatabaseUrl, { max: poolMax });
    }
    this.#admin = drizzle(this.#adminRaw);
    this.#public = drizzle(this.#publicRaw);
    this.#skipVerify = config.skipRoleVerification === true;
  }

  /**
   * One-shot startup self-check. Asserts that:
   *   - the admin pool connects as `admin_role` to `cms_admin`
   *   - the public pool connects to `cms_public` as `admin_role` or `public_role`
   *
   * Memoised — runs once and remembers. Exposed as a public method so callers
   * can fail-fast on startup instead of at first op. Also runs automatically
   * before the first `runOperation()` unless `skipRoleVerification` is set.
   */
  verifyRoles(): Promise<void> {
    // Not `async` on purpose — we return the cached Promise *reference* so a
    // second call === the first; `async` would wrap it in a fresh Promise and
    // break that identity.
    if (this.#verifyPromise !== null) return this.#verifyPromise;
    this.#verifyPromise = this.#verifyRolesOnce();
    return this.#verifyPromise;
  }

  async #verifyRolesOnce(): Promise<void> {
    const admin = await this.#identity(this.#adminRaw);
    if (admin.user !== "admin_role" || admin.database !== "cms_admin") {
      throw new Error(
        `DatabaseAdapter admin pool expected (admin_role, cms_admin) but connected as (${admin.user}, ${admin.database}). Check ADMIN_DATABASE_URL.`,
      );
    }
    const pub = await this.#identity(this.#publicRaw);
    if (pub.database !== "cms_public") {
      throw new Error(
        `DatabaseAdapter public pool expected database cms_public but connected to ${pub.database}. Check PUBLIC_DATABASE_URL / PUBLIC_ADMIN_DATABASE_URL.`,
      );
    }
    if (pub.user !== "admin_role" && pub.user !== "public_role") {
      throw new Error(
        `DatabaseAdapter public pool expected user admin_role or public_role, got ${pub.user}.`,
      );
    }
  }

  async #identity(pool: SQL): Promise<ConnectionIdentity> {
    const rows =
      (await pool`SELECT current_user::text AS user, current_database()::text AS database`) as unknown as ConnectionIdentity[];
    const row = rows[0];
    if (!row) throw new Error("connection identity probe returned no row");
    return row;
  }

  /**
   * Execute an operation inside a transaction scoped to the caller's identity.
   * Session vars are set via `set_config(name, value, true)` (parameterised) so
   * there is no string interpolation at the SQL boundary.
   */
  async runOperation<I, O>(
    op: OperationDefinition<I, O>,
    ctx: ExecutionContext,
    validatedInput: I,
  ): Promise<Result<O, QueryError>> {
    if (!this.#skipVerify) await this.verifyRoles();

    const db = op.database === "cms_admin" ? this.#admin : this.#public;

    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('caelo.actor_id', ${ctx.actorId}, true)`);
        await tx.execute(sql`SELECT set_config('caelo.actor_kind', ${ctx.actorKind}, true)`);
        await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true)`);
        // P5: optional chat-branch / chat-task identity. Snapshot writes
        // read these via ctx.chatBranchId / ctx.chatTaskId; the session
        // vars exist for any future read-side query that wants to scope
        // by branch without an extra parameter.
        await tx.execute(
          sql`SELECT set_config('caelo.chat_branch_id', ${ctx.chatBranchId ?? ""}, true)`,
        );
        await tx.execute(
          sql`SELECT set_config('caelo.chat_task_id', ${ctx.chatTaskId ?? ""}, true)`,
        );

        return await op.handler(ctx, validatedInput, tx);
      });
    } catch (thrown) {
      // Run #9 R8 — handler-requested abort: the throw already rolled the
      // transaction back; hand the structured error to the caller as a
      // plain Result. See OperationAbortError for when handlers use this.
      if (thrown instanceof OperationAbortError) {
        return err(thrown.queryError);
      }
      if (isRlsDenial(thrown)) {
        return err({
          kind: "RLSDenied",
          operation: op.name,
          detail: (thrown as { message?: string }).message ?? "RLS policy denied the write",
        });
      }
      // v0.5.17 — extract Postgres structured fields from the throw
      // before the message is the only thing the caller sees. Bun.SQL
      // puts SQL text in `.message` and the actual reason (SQLSTATE,
      // constraint, detail) on `.cause`. Without this, `describeError`
      // gets only "Failed query: <sql>" and operators can't diagnose.
      const pgDetail = extractPgFields(thrown);
      return err({
        kind: "HandlerError",
        operation: op.name,
        message: thrown instanceof Error ? thrown.message : String(thrown),
        ...(pgDetail ? { pgDetail } : {}),
      });
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.#adminRaw.end(), this.#publicRaw.end()]);
  }

  /**
   * Open an admin-DB transaction with the caller's identity set via
   * session vars and run an arbitrary callback. Used by tooling that
   * needs the same RLS-correct read view as the Query API ops but is
   * not itself an op (e.g. the static generator subprocess in P6.2).
   *
   * Throws on RLS denial and any handler error — callers handle their
   * own error shape since they don't pass through the op result type.
   */
  async withAdminTransaction<T>(
    ctx: ExecutionContext,
    fn: (tx: TransactionRunner) => Promise<T>,
  ): Promise<T> {
    if (!this.#skipVerify) await this.verifyRoles();
    return await this.#admin.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('caelo.actor_id', ${ctx.actorId}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', ${ctx.actorKind}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true)`);
      await tx.execute(
        sql`SELECT set_config('caelo.chat_branch_id', ${ctx.chatBranchId ?? ""}, true)`,
      );
      await tx.execute(sql`SELECT set_config('caelo.chat_task_id', ${ctx.chatTaskId ?? ""}, true)`);
      return await fn(tx);
    });
  }

  /** Test-only: raw access for fixture setup / adversarial direct queries. */
  rawAdmin(): SQL {
    return this.#adminRaw;
  }
  rawPublic(): SQL {
    return this.#publicRaw;
  }

  /**
   * Provision a plugin's cms_public schema by running emitted DDL
   * (CREATE SCHEMA / CREATE TABLE / RLS) inside one transaction. The
   * SQL is produced by `@caelo-cms/plugin-sandbox/schema.schemaFromSpec`,
   * which is itself fed from the plugin's validated manifest.
   *
   * Runs as `system` actor so RLS doesn't gate DDL grants. Idempotent
   * (every CREATE uses IF NOT EXISTS); safe to retry on partial failure.
   * Used by the activate path: provision FIRST, then commit the
   * cms_admin status flip in the activate op. If provisioning fails,
   * the activate path returns the error before any cms_admin mutation.
   */
  async provisionPluginPublicSchema(opts: { pluginId: string; sql: string }): Promise<void> {
    if (!this.#skipVerify) await this.verifyRoles();
    await this.#public.transaction(async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql.raw(`SELECT set_config('caelo.plugin_id', '${opts.pluginId}', true)`));
      // The emitted SQL is constructed entirely from validated identifiers
      // (slug regex `^[a-z][a-z0-9-]*$`, table names regex `^[a-z_][a-z0-9_]*$`)
      // and the plugin id is a UUID column from cms_admin.plugins, never user-provided
      // text. `quoteIdent` in plugin-sandbox/src/schema.ts throws on any
      // identifier that doesn't match the safe pattern.
      await tx.execute(sql.raw(opts.sql));
    });
  }

  /**
   * Roll back a previously provisioned plugin schema. Called by the
   * activate orchestration when the cms_admin commit fails AFTER
   * cms_public DDL succeeded — without this, the cms_public side
   * would leak (`plugin_<slug>` schema exists with no owning row).
   *
   * Validates the schemaName against the same regex schemaFromSpec
   * uses — accepts only `plugin_<slug>` shapes (lowercase + underscores)
   * to keep the DROP boundary watertight.
   */
  async dropPluginPublicSchema(opts: { schemaName: string }): Promise<void> {
    if (!this.#skipVerify) await this.verifyRoles();
    if (!/^plugin_[a-z][a-z0-9_]*$/.test(opts.schemaName)) {
      throw new Error(
        `dropPluginPublicSchema: refusing to drop schema "${opts.schemaName}" — name doesn't match plugin_<slug> pattern`,
      );
    }
    await this.#public.transaction(async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS "${opts.schemaName}" CASCADE`));
    });
  }

  get admin(): BunSQLDatabase {
    return this.#admin;
  }
  get public(): BunSQLDatabase {
    return this.#public;
  }
}
