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
import { branchNotFound, firstInvisibleBranch, namedBranches } from "./branch-access.js";
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
  /**
   * The cms_admin URL, or `null` for a public-side process (the API
   * gateway, issue #635): it then holds no cms_admin pool at all, and every
   * path that would reach the authoring database throws
   * {@link AdminDatabaseUnavailableError} instead of connecting.
   */
  readonly adminDatabaseUrl: string | null;
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
  /**
   * The identities {@link DatabaseAdapter.verifyRoles} accepts. Defaults to
   * the authoring roles (`admin_role` on cms_admin; `admin_role` or
   * `public_role` on cms_public). Only a process that deliberately runs with
   * a narrower role sets it — the operator-access sync job, which connects
   * as its own read-only Cloud SQL IAM user — so a misrouted URL still fails
   * loudly instead of silently running as someone else.
   */
  readonly expectedRoles?: {
    /** The admin pool's role; `null` exactly when `adminDatabaseUrl` is `null`. */
    readonly admin: string | null;
    readonly public: readonly string[];
  };
}

const DEFAULT_ROLES = { admin: "admin_role", public: ["admin_role", "public_role"] } as const;

/**
 * Thrown when a public-side process (constructed with
 * `adminDatabaseUrl: null`) reaches for cms_admin. The public side has no
 * path to the authoring database by design (CLAUDE.md §2, issue #635), so
 * this is always a bug in the caller, never a condition to recover from.
 */
export class AdminDatabaseUnavailableError extends Error {
  override readonly name = "AdminDatabaseUnavailableError";
  constructor(what: string) {
    super(
      `${what}: this process has no cms_admin connection by design (public side, CLAUDE.md §2). Read what the admin published into cms_public instead.`,
    );
  }
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
  readonly #admin: BunSQLDatabase | null;
  readonly #public: BunSQLDatabase;
  readonly #adminRaw: SQL | null;
  readonly #publicRaw: SQL;
  readonly #skipVerify: boolean;
  readonly #roles: { readonly admin: string | null; readonly public: readonly string[] };
  #verifyPromise: Promise<void> | null = null;
  #projectionPublisher: (() => Promise<unknown>) | null = null;

  constructor(config: AdapterConfig) {
    this.#roles = config.expectedRoles ?? DEFAULT_ROLES;
    if ((config.adminDatabaseUrl === null) !== (this.#roles.admin === null)) {
      throw new Error(
        "DatabaseAdapter: a public-only adapter (adminDatabaseUrl: null) must expect no admin role, and an adapter with an admin URL must expect one",
      );
    }
    // When no pool cap is configured (the production case) keep the original
    // 1-arg construction so behaviour is byte-for-byte unchanged: Bun default 10.
    const poolMax = resolvePoolMax(config.poolMax);
    const open = (url: string): SQL =>
      poolMax === undefined ? new SQL(url) : new SQL(url, { max: poolMax });
    this.#adminRaw = config.adminDatabaseUrl === null ? null : open(config.adminDatabaseUrl);
    this.#publicRaw = open(config.publicDatabaseUrl);
    this.#admin = this.#adminRaw === null ? null : drizzle(this.#adminRaw);
    this.#public = drizzle(this.#publicRaw);
    this.#skipVerify = config.skipRoleVerification === true;
  }

  /**
   * Whether this process holds a cms_admin pool. False for the public-side
   * API gateway (issue #635): its plugin host then reads the projection the
   * admin publishes into cms_public instead of authoring state.
   */
  get hasAdminDatabase(): boolean {
    return this.#admin !== null;
  }

  /**
   * Issue #635 — register the publisher of the gateway projection. After
   * any cms_admin transaction of this adapter commits a change to
   * published state (cms_admin 0281's triggers mark it with
   * `caelo.projection_dirty`), the adapter runs `publish` and waits for it
   * BEFORE the op or transaction returns. A revoked grant, a deactivated
   * plugin, an unapproved comment, a rotated cookie secret or a closed
   * staging gate is therefore live on the public side when the admin call
   * returns — not whenever an interval timer next gets CPU (Cloud Run
   * throttles CPU outside requests, and scales to zero). The publisher's
   * own poll and the boot/migration publish remain as crash recovery.
   */
  setProjectionPublisher(publish: (() => Promise<unknown>) | null): void {
    this.#projectionPublisher = publish;
  }

  /** Whether this transaction changed published state (see {@link setProjectionPublisher}). */
  async #projectionDirty(tx: TransactionRunner): Promise<boolean> {
    if (this.#projectionPublisher === null) return false;
    const found = (await tx.execute(
      sql`SELECT current_setting('caelo.projection_dirty', true) AS v`,
    )) as unknown as { v: string | null }[];
    return found[0]?.v === "on";
  }

  async #publishAfterCommit(): Promise<void> {
    const publish = this.#projectionPublisher;
    if (publish !== null) await publish();
  }

  #adminDb(what: string): BunSQLDatabase {
    if (this.#admin === null) throw new AdminDatabaseUnavailableError(what);
    return this.#admin;
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
    // Only a success is remembered. A failure (the database is still being
    // migrated, a role has no password yet) is retried by the next caller,
    // so a long-running process — the API gateway on a fresh install —
    // recovers once the database is ready instead of failing every call
    // until it restarts. A wrong identity keeps failing loudly each time.
    this.#verifyPromise = this.#verifyRolesOnce().catch((e: unknown) => {
      this.#verifyPromise = null;
      throw e;
    });
    return this.#verifyPromise;
  }

  async #verifyRolesOnce(): Promise<void> {
    if (this.#adminRaw !== null) {
      const admin = await this.#identity(this.#adminRaw);
      if (admin.user !== this.#roles.admin || admin.database !== "cms_admin") {
        throw new Error(
          `DatabaseAdapter admin pool expected (${this.#roles.admin}, cms_admin) but connected as (${admin.user}, ${admin.database}). Check ADMIN_DATABASE_URL.`,
        );
      }
    }
    const pub = await this.#identity(this.#publicRaw);
    if (pub.database !== "cms_public") {
      throw new Error(
        `DatabaseAdapter public pool expected database cms_public but connected to ${pub.database}. Check PUBLIC_DATABASE_URL / PUBLIC_ADMIN_DATABASE_URL.`,
      );
    }
    if (!this.#roles.public.includes(pub.user)) {
      throw new Error(
        `DatabaseAdapter public pool expected user ${this.#roles.public.join(" or ")}, got ${pub.user}.`,
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

    const db = op.database === "cms_admin" ? this.#adminDb(`operation ${op.name}`) : this.#public;
    let publishAfterCommit = false;

    let result: Result<O, QueryError>;
    try {
      result = await db.transaction(async (tx) => {
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

        // Issue #569 — a branch the caller may not see is answered as
        // "not found" before the handler runs, so no op can read or write
        // another editor's unpublished work by naming its branch. Branches
        // (and the visibility rule) live in cms_admin only.
        if (op.database === "cms_admin") {
          const denied = await firstInvisibleBranch(tx, namedBranches(ctx, validatedInput));
          if (denied !== null) return err(branchNotFound(op.name, denied));
        }

        const out = await op.handler(ctx, validatedInput, tx);
        if (out.ok && op.database === "cms_admin") {
          publishAfterCommit = await this.#projectionDirty(tx);
        }
        return out;
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
    if (publishAfterCommit) {
      try {
        await this.#publishAfterCommit();
      } catch (thrown) {
        return err({
          kind: "HandlerError",
          operation: op.name,
          message: `The change is saved, but the public site does not serve it yet: publishing it failed (${thrown instanceof Error ? thrown.message : String(thrown)}). Do not repeat the change; it is published automatically within seconds once the public database answers.`,
        });
      }
    }
    return result;
  }

  async close(): Promise<void> {
    await Promise.all([this.#adminRaw?.end(), this.#publicRaw.end()]);
  }

  /**
   * Open an admin-DB transaction with the caller's identity set via
   * session vars and run an arbitrary callback. Used by tooling that
   * needs the same RLS-correct read view as the Query API ops but is
   * not itself an op (e.g. the static generator subprocess in P6.2).
   *
   * Throws on RLS denial and any handler error — callers handle their
   * own error shape since they don't pass through the op result type.
   * A `ctx.chatBranchId` the caller may not see throws an
   * `OperationAbortError` carrying `BranchNotFound` (issue #569).
   */
  async withAdminTransaction<T>(
    ctx: ExecutionContext,
    fn: (tx: TransactionRunner) => Promise<T>,
  ): Promise<T> {
    const admin = this.#adminDb("withAdminTransaction");
    if (!this.#skipVerify) await this.verifyRoles();
    let publishAfterCommit = false;
    const out = await admin.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('caelo.actor_id', ${ctx.actorId}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', ${ctx.actorKind}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true)`);
      await tx.execute(
        sql`SELECT set_config('caelo.chat_branch_id', ${ctx.chatBranchId ?? ""}, true)`,
      );
      await tx.execute(sql`SELECT set_config('caelo.chat_task_id', ${ctx.chatTaskId ?? ""}, true)`);
      // Issue #569 — same branch-visibility gate as runOperation.
      const denied = await firstInvisibleBranch(tx, namedBranches(ctx, undefined));
      if (denied !== null) {
        throw new OperationAbortError(branchNotFound("withAdminTransaction", denied));
      }
      const result = await fn(tx);
      publishAfterCommit = await this.#projectionDirty(tx);
      return result;
    });
    // #635 — published state changed: live on the public side before returning.
    if (publishAfterCommit) await this.#publishAfterCommit();
    return out;
  }

  /**
   * Open a cms_public transaction with the caller's identity set via
   * session vars and run an arbitrary callback — the cms_public twin of
   * {@link withAdminTransaction}. cms_public has no chat branches (its rows
   * are live visitor data), so no branch identity is set or checked.
   */
  async withPublicTransaction<T>(
    ctx: ExecutionContext,
    fn: (tx: TransactionRunner) => Promise<T>,
  ): Promise<T> {
    if (!this.#skipVerify) await this.verifyRoles();
    return await this.#public.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('caelo.actor_id', ${ctx.actorId}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', ${ctx.actorKind}, true)`);
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true)`);
      return await fn(tx);
    });
  }

  /** Test-only: raw access for fixture setup / adversarial direct queries. */
  rawAdmin(): SQL {
    if (this.#adminRaw === null) throw new AdminDatabaseUnavailableError("rawAdmin");
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
    if (!/^[0-9a-f-]{36}$/i.test(opts.pluginId)) {
      throw new Error(`provisionPluginPublicSchema: pluginId "${opts.pluginId}" is not a UUID`);
    }
    if (!this.#skipVerify) await this.verifyRoles();
    await this.#public.transaction(async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${opts.pluginId}, true)`);
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
  /**
   * #389 — provision a release-signed plugin's OWN cms_admin schema
   * (`plugin_<slug>`) from DDL emitted by
   * `plugin-sandbox/schema.adminSchemaFromSpec`. Same trust reasoning as
   * the cms_public variant above: identifiers are regex-validated at
   * emission, the plugin id is a cms_admin UUID, all statements are
   * IF-NOT-EXISTS/ADD-IF-NOT-EXISTS guarded (idempotent + additive
   * evolution on version bumps). Runs as `system` actor on the ADMIN
   * pool.
   */
  async provisionPluginAdminSchema(opts: { pluginId: string; sql: string }): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(opts.pluginId)) {
      throw new Error(`provisionPluginAdminSchema: pluginId "${opts.pluginId}" is not a UUID`);
    }
    const admin = this.#adminDb("provisionPluginAdminSchema");
    if (!this.#skipVerify) await this.verifyRoles();
    await admin.transaction(async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${opts.pluginId}, true)`);
      await tx.execute(sql.raw(opts.sql));
    });
  }

  /**
   * #389 — drop a plugin's cms_admin schema (uninstall path, #393).
   * Same watertight name gate as the cms_public variant.
   */
  async dropPluginAdminSchema(opts: { schemaName: string }): Promise<void> {
    const admin = this.#adminDb("dropPluginAdminSchema");
    if (!this.#skipVerify) await this.verifyRoles();
    if (!/^plugin_[a-z][a-z0-9_]*$/.test(opts.schemaName)) {
      throw new Error(
        `dropPluginAdminSchema: refusing to drop schema "${opts.schemaName}" — name doesn't match plugin_<slug> pattern`,
      );
    }
    await admin.transaction(async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS "${opts.schemaName}" CASCADE`));
    });
  }

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
    return this.#adminDb("admin pool");
  }
  get public(): BunSQLDatabase {
    return this.#public;
  }
}
