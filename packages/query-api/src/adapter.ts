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
  readonly max?: number;
  readonly idleTimeout: number;
}
const SQL = (globalThis as { Bun?: { SQL: new (url: string, options?: PoolOptions) => SQLType } })
  .Bun?.SQL as unknown as new (
  url: string,
  options?: PoolOptions,
) => SQLType;

import { sql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { recordAudit, SYSTEM_ACTOR_ID } from "./audit.js";
import { branchNotFound, firstInvisibleBranch, namedBranches } from "./branch-access.js";
import { extractPgFields, isRlsDenial, OperationAbortError, type QueryError } from "./errors.js";
import {
  type AnyOperationDefinition,
  isReadOperation,
  type OperationDefinition,
  type ReadOperationDefinition,
  type ReadScope,
  type TransactionRunner,
} from "./operation.js";
import { type ProvisionOutcome, provisionPluginSchemaInTx } from "./plugin-schema-provision.js";
import {
  detachedRunner,
  exemptFromSessionTimeouts,
  type HeldTransaction,
  liftSessionTimeouts,
  NestedPoolCheckoutError,
  POOL_ACQUIRE_TIMEOUT_MS,
  PoolAcquireTimeoutError,
  PoolGuard,
  type PoolName,
} from "./pool-guard.js";
import {
  collectPostCommitEffects,
  notifyOperationCommitted,
  type PostCommitEffect,
  type PostCommitFailure,
  runPostCommitEffects,
  shareCommitEffects,
} from "./post-commit.js";

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
   * Overrides {@link POOL_IDLE_TIMEOUT_SECONDS}. Only for the tests that
   * prove a pool recovers from silently dropped connections in seconds.
   */
  readonly poolIdleTimeoutSeconds?: number;
  /**
   * Overrides {@link POOL_ACQUIRE_TIMEOUT_MS}. Only for the tests that prove
   * an exhausted pool answers in time instead of queueing forever.
   */
  readonly poolAcquireTimeoutMs?: number;
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
  /**
   * Called with the text of every statement either pool runs, and with
   * `BEGIN` / `COMMIT` for every transaction the adapter opens. Only for
   * the benchmarks that count database round-trips (issue #1212); left
   * unset everywhere else.
   */
  readonly onStatement?: (statement: string) => void;
}

const DEFAULT_ROLES = { admin: "admin_role", public: ["admin_role", "public_role"] } as const;

/** Options of {@link DatabaseAdapter.withAdminTransaction} / `withPublicTransaction`. */
export interface TransactionOptions {
  /**
   * The name this transaction is known by in a {@link NestedPoolCheckoutError}
   * and in the guard's allowlist (pool-guard.ts). Name a transaction that
   * stays open across other work, so an error points at its caller.
   */
  readonly holder?: string;
}

/**
 * Seconds a pooled connection may sit unused in the pool before Bun closes it.
 *
 * Without it (Bun's default is no limit) a connection can idle long enough
 * for the network to forget its flow without a reset — GCP drops idle TCP
 * flows after about 10 minutes. The next query handed to it then waits
 * forever. Production lost its admin that way for a day: every database
 * request hung until Cloud Run's 3600 s request timeout while the process
 * looked healthy. Five minutes keeps every pooled connection younger than
 * that, so the pool never hands out a forgotten one.
 *
 * Safe for long transactions only from Bun 1.4.4 on: before, Bun counted
 * silence on a checked-out connection too and killed a transaction that
 * waited on an advisory lock while another one published the site
 * (live-release-lock.ts, deploy.promote). {@link MIN_BUN_VERSION} guards it.
 */
export const POOL_IDLE_TIMEOUT_SECONDS = 300;

/** Bun.SQL's error code when Postgres answered COMMIT on an aborted transaction with a rollback. */
const COMMIT_ROLLED_BACK = "ERR_POSTGRES_COMMIT_ROLLED_BACK";

/** The first Bun whose `idleTimeout` spares checked-out connections (see above). */
export const MIN_BUN_VERSION = "1.4.4";

/**
 * Throw unless `version` is at least {@link MIN_BUN_VERSION}. An older Bun
 * would abort legitimate transactions after {@link POOL_IDLE_TIMEOUT_SECONDS}
 * of silence, so the adapter refuses to start instead.
 */
export function assertPoolSafeBun(version: string): void {
  const parts = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
  const have = parts(version);
  const need = parts(MIN_BUN_VERSION);
  for (let i = 0; i < need.length; i++) {
    const h = have[i] ?? 0;
    const n = need[i] ?? 0;
    if (h > n) return;
    if (h < n) {
      throw new Error(
        `DatabaseAdapter needs Bun >= ${MIN_BUN_VERSION} (running ${version}): older Bun closes pooled connections mid-transaction after the idle timeout. Upgrade Bun.`,
      );
    }
  }
}

/**
 * Thrown by {@link DatabaseAdapter.ping} when a pool does not answer
 * its identity probe within the deadline: its connections hang (see
 * {@link POOL_IDLE_TIMEOUT_SECONDS}) or the database is overloaded.
 */
export class DatabaseUnresponsiveError extends Error {
  override readonly name = "DatabaseUnresponsiveError";
  constructor(pool: "admin" | "public", deadlineMs: number) {
    super(
      `the ${pool} database pool did not answer within ${deadlineMs} ms; its connections hang or the database is overloaded`,
    );
  }
}

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
 * the explicit option nor `CAELO_DB_POOL_MAX` is set, so the caller passes no
 * `max` and inherits Bun's default of 10 — making this a no-op in production
 * where neither knob is present.
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

/** Settle with `work`, or reject with `onMissed()` once `signal` aborts first. */
function withDeadline<T>(
  work: PromiseLike<T>,
  signal: AbortSignal,
  onMissed: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(onMissed());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onMissed());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}

interface ConnectionIdentity {
  readonly user: string;
  readonly database: string;
}

/**
 * The error text for effects that failed after their commit: the write is
 * saved (repeating it would apply it twice), only its in-process follow-up
 * did not happen.
 */
function postCommitFailureMessage(failures: ReadonlyArray<PostCommitFailure>): string {
  const list = failures.map((f) => `${f.effect.label} (${f.message})`).join("; ");
  return `The change is saved, but its follow-up in the running server failed: ${list}. Do not repeat the change. Restart the admin server so the running state is rebuilt from the saved data; the failure is in the audit log.`;
}

export class DatabaseAdapter {
  readonly #admin: BunSQLDatabase | null;
  readonly #public: BunSQLDatabase;
  readonly #adminRaw: SQL | null;
  readonly #publicRaw: SQL;
  readonly #skipVerify: boolean;
  readonly #roles: { readonly admin: string | null; readonly public: readonly string[] };
  readonly #acquireTimeoutMs: number;
  /** Issue #1210 — which call chains hold a transaction of which pool. */
  readonly #guard = new PoolGuard();
  #verifyPromise: Promise<void> | null = null;
  #projectionPublisher: (() => Promise<unknown>) | null = null;
  readonly #onStatement: ((statement: string) => void) | null;
  /** The statement logger (onStatement) every drizzle handle of this adapter carries. */
  readonly #drizzleOptions: { logger?: { logQuery: (query: string) => void } };

  constructor(config: AdapterConfig) {
    this.#roles = config.expectedRoles ?? DEFAULT_ROLES;
    if ((config.adminDatabaseUrl === null) !== (this.#roles.admin === null)) {
      throw new Error(
        "DatabaseAdapter: a public-only adapter (adminDatabaseUrl: null) must expect no admin role, and an adapter with an admin URL must expect one",
      );
    }
    assertPoolSafeBun(globalThis.Bun?.version ?? "0");
    // No pool cap configured (the production case) keeps Bun's default of 10.
    const poolMax = resolvePoolMax(config.poolMax);
    const idleTimeout = config.poolIdleTimeoutSeconds ?? POOL_IDLE_TIMEOUT_SECONDS;
    const open = (url: string): SQL =>
      new SQL(url, poolMax === undefined ? { idleTimeout } : { max: poolMax, idleTimeout });
    this.#adminRaw = config.adminDatabaseUrl === null ? null : open(config.adminDatabaseUrl);
    this.#publicRaw = open(config.publicDatabaseUrl);
    this.#onStatement = config.onStatement ?? null;
    const observe = this.#onStatement;
    this.#drizzleOptions = observe
      ? { logger: { logQuery: (query: string) => observe(query) } }
      : {};
    this.#admin = this.#adminRaw === null ? null : drizzle(this.#adminRaw, this.#drizzleOptions);
    this.#public = drizzle(this.#publicRaw, this.#drizzleOptions);
    this.#skipVerify = config.skipRoleVerification === true;
    this.#acquireTimeoutMs = config.poolAcquireTimeoutMs ?? POOL_ACQUIRE_TIMEOUT_MS;
  }

  /**
   * Open a transaction on its own reserved connection of `pool`, with the
   * call chain marked as holding it (pool-guard.ts). The connection is
   * reserved with a deadline because Bun.SQL's own `begin()` waits for a
   * free connection forever.
   *
   * @throws NestedPoolCheckoutError when the chain already holds `pool`.
   * @throws PoolAcquireTimeoutError when no connection frees up in time.
   */
  async #transaction<T>(
    pool: PoolName,
    holder: string,
    fn: (tx: TransactionRunner, joined: boolean) => Promise<T>,
  ): Promise<T> {
    const raw = pool === "admin" ? this.#adminRaw : this.#publicRaw;
    if (raw === null) throw new AdminDatabaseUnavailableError(holder);
    const plan = this.#guard.plan(pool, holder);
    if (plan.kind === "join") return this.#joinHeld(pool, plan.outer, plan.marker, fn);
    const marker = plan.marker;
    const reserved = await this.#reserve(pool, raw, holder);
    try {
      // drizzle's transaction() is `client.begin()`, which on a reserved
      // connection runs on exactly that connection.
      const db = drizzle({ client: reserved as unknown as SQL, ...this.#drizzleOptions });
      this.#onStatement?.("BEGIN");
      const out = await db.transaction((tx) =>
        this.#guard.run(pool, marker, async () => {
          marker.tx = tx;
          if (exemptFromSessionTimeouts(holder)) await liftSessionTimeouts(tx);
          return fn(tx, false);
        }),
      );
      this.#onStatement?.("COMMIT");
      return out;
    } finally {
      reserved.release();
      await this.#runAfterEnd(marker);
    }
  }

  /**
   * #1254 — run `fn` as a SAVEPOINT of the transaction `outer` this call
   * chain holds (see `joinHeldTransaction`), instead of on a second
   * connection. Joined calls directly under one transaction run one at a
   * time (one connection, one savepoint stack). `fn` sets its own identity
   * like any transaction of the adapter; the holder's is restored when the
   * savepoint is released (a rolled-back savepoint reverts it by itself).
   * Its post-commit effects wait for the holder's commit.
   */
  #joinHeld<T>(
    pool: PoolName,
    outer: HeldTransaction,
    marker: HeldTransaction,
    fn: (tx: TransactionRunner, joined: boolean) => Promise<T>,
  ): Promise<T> {
    return outer.joined.run(async () => {
      const outerTx = outer.tx;
      const rootTx = (outer.root ?? outer).tx;
      if (outerTx === null || rootTx === null || !outer.active) {
        throw new NestedPoolCheckoutError(pool, outer.holder, marker.holder);
      }
      const out = await outerTx.transaction((savepoint) =>
        this.#guard.run(pool, marker, async () => {
          marker.tx = savepoint;
          shareCommitEffects(savepoint, rootTx);
          return fn(savepoint, true);
        }),
      );
      // The full identity: a superset of what either pool's transactions
      // set, and an extra custom setting is harmless.
      if (outer.identity !== null) await this.#setIdentity(outerTx, outer.identity);
      return out;
    });
  }

  /** The work a transaction deferred until it ended ({@link deferUntilHeldTransactionEnds}). */
  async #runAfterEnd(marker: HeldTransaction): Promise<void> {
    for (const work of marker.afterEnd.splice(0)) {
      try {
        await work();
      } catch (thrown) {
        console.error("[query-api] work deferred until a transaction ended failed", {
          holder: marker.holder,
          error: thrown instanceof Error ? thrown.message : String(thrown),
        });
      }
    }
  }

  /**
   * #1254 — run `work` once the transaction this call chain holds on the
   * admin pool has ended and released its connection (committed or rolled
   * back), or right away when it holds none. For a record that must not
   * ride on — and roll back with — the holder's transaction, such as a
   * plugin failure noticed inside a joined render call. A failure of
   * deferred work is logged; there is no caller left to hand it to.
   *
   * @returns true when `work` was deferred.
   */
  deferUntilHeldTransactionEnds(work: () => Promise<void>): Promise<boolean> {
    return this.#guard.deferUntilEnd("admin", work);
  }

  /**
   * Whether this call chain holds an open transaction of `pool`. A Tier-2
   * plugin call must not run while one does (#1254): its sandbox round trip
   * would keep the holder idle in transaction.
   */
  holdsTransaction(pool: PoolName): boolean {
    return this.#guard.held(pool) !== null;
  }

  /** Reserve one connection of `raw`, waiting at most the acquire deadline. */
  async #reserve(
    pool: PoolName,
    raw: SQL,
    requester: string,
  ): Promise<Awaited<ReturnType<SQL["reserve"]>>> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#acquireTimeoutMs);
    try {
      return await raw.reserve({ signal: deadline.signal });
    } catch (e) {
      if (deadline.signal.aborted) {
        throw new PoolAcquireTimeoutError(pool, requester, this.#acquireTimeoutMs);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
    if (this.#adminRaw !== null)
      this.#assertIdentity("admin", await this.#identity(this.#adminRaw));
    this.#assertIdentity("public", await this.#identity(this.#publicRaw));
  }

  #assertIdentity(pool: "admin" | "public", id: ConnectionIdentity): void {
    if (pool === "admin") {
      if (id.user !== this.#roles.admin || id.database !== "cms_admin") {
        throw new Error(
          `DatabaseAdapter admin pool expected (${this.#roles.admin}, cms_admin) but connected as (${id.user}, ${id.database}). Check ADMIN_DATABASE_URL.`,
        );
      }
      return;
    }
    if (id.database !== "cms_public") {
      throw new Error(
        `DatabaseAdapter public pool expected database cms_public but connected to ${id.database}. Check PUBLIC_DATABASE_URL / PUBLIC_ADMIN_DATABASE_URL.`,
      );
    }
    if (!this.#roles.public.includes(id.user)) {
      throw new Error(
        `DatabaseAdapter public pool expected user ${this.#roles.public.join(" or ")}, got ${id.user}.`,
      );
    }
  }

  /**
   * Prove that every pool answers right now as its expected role, bounded
   * by `deadlineMs`: the identity probe of {@link verifyRoles} on a
   * connection reserved from each pool. Unlike `verifyRoles` it is never
   * remembered and never waits on a remembered probe, so a health check
   * built on it notices a pool whose connections started hanging after the
   * first success, and answers in time even when the first probe hangs.
   *
   * When the deadline wins, the reserved connection is closed rather than
   * returned: an abandoned query must not keep holding a pool slot, or
   * repeated health probes during an outage would fill the pool with them.
   *
   * @throws DatabaseUnresponsiveError naming a pool that missed the deadline.
   */
  async ping(deadlineMs: number): Promise<void> {
    const deadline = AbortSignal.timeout(deadlineMs);
    const pools: ["admin" | "public", SQL][] = [["public", this.#publicRaw]];
    if (this.#adminRaw !== null) pools.unshift(["admin", this.#adminRaw]);
    await Promise.all(
      pools.map(async ([name, pool]) => {
        const unresponsive = () => new DatabaseUnresponsiveError(name, deadlineMs);
        let reserved: Awaited<ReturnType<SQL["reserve"]>>;
        try {
          reserved = await pool.reserve({ signal: deadline });
        } catch (e) {
          if (deadline.aborted) throw unresponsive();
          throw e;
        }
        let identity: ConnectionIdentity;
        try {
          identity = await withDeadline(this.#identity(reserved), deadline, unresponsive);
        } catch (e) {
          await reserved.close().catch(() => undefined);
          throw e;
        }
        reserved.release();
        this.#assertIdentity(name, identity);
      }),
    );
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
    op: AnyOperationDefinition<I, O>,
    ctx: ExecutionContext,
    validatedInput: I,
  ): Promise<Result<O, QueryError>> {
    const pool: PoolName = op.database === "cms_admin" ? "admin" : "public";
    this.#guard.assertMayCheckout(pool, op.name);
    if (op.database === "cms_admin") this.#adminDb(`operation ${op.name}`);
    if (!this.#skipVerify) await this.verifyRoles();
    if (isReadOperation(op)) return this.#runReadOperation(op, ctx, validatedInput);
    if (op.transaction === "none") return this.#runDetached(op, ctx, validatedInput);

    let publishAfterCommit = false;
    // Filled by handlers via `afterCommit(tx, …)`; only read once the
    // transaction below committed (a throw skips it along with the tx).
    let postCommit: PostCommitEffect[] = [];

    let result: Result<O, QueryError>;
    // The handler's own error Result, kept for the COMMIT_ROLLED_BACK case below.
    let handlerError: Result<O, QueryError> | null = null;
    // #1254 — joined to the transaction the call chain holds: it commits
    // with that one, so the projection and change hints are the holder's.
    let joinedHolder = false;
    try {
      result = await this.#transaction(pool, op.name, async (tx, joined) => {
        joinedHolder = joined;
        if (!joined) postCommit = collectPostCommitEffects(tx);
        await this.#setIdentity(tx, ctx);

        // Issue #569 — a branch the caller may not see is answered as
        // "not found" before the handler runs, so no op can read or write
        // another editor's unpublished work by naming its branch. Branches
        // (and the visibility rule) live in cms_admin only.
        if (op.database === "cms_admin") {
          const denied = await firstInvisibleBranch(tx, namedBranches(ctx, validatedInput));
          if (denied !== null) return err(branchNotFound(op.name, denied));
        }

        const out = await op.handler(ctx, validatedInput, tx);
        if (!out.ok) handlerError = out;
        if (out.ok && !joined && op.database === "cms_admin") {
          publishAfterCommit = await this.#projectionDirty(tx);
        }
        return out;
      });
    } catch (thrown) {
      // Issue #1210 — a nested checkout is a bug in the code, not an
      // outcome: an error Result would let the outer handler swallow it.
      if (thrown instanceof NestedPoolCheckoutError) throw thrown;
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
      // A handler that caught a failed statement (a duplicate pending
      // proposal's unique violation) and answered with its own error leaves
      // an aborted transaction; Postgres turns the COMMIT into a rollback,
      // which Bun >= 1.4.4 reports as a throw. Nothing was written, so the
      // handler's error is the answer. A handler that answered ok on an
      // aborted transaction gets no such pass: its writes are lost, loudly.
      if (pgDetail?.code === COMMIT_ROLLED_BACK && handlerError !== null) {
        return handlerError;
      }
      return err({
        kind: "HandlerError",
        operation: op.name,
        message: thrown instanceof Error ? thrown.message : String(thrown),
        ...(pgDetail ? { pgDetail } : {}),
      });
    }
    // #585 — the commit happened, so both follow-ups run whatever the
    // other's outcome: deferred in-process effects, then the projection.
    const effectFailures = await this.#settlePostCommit(op.name, ctx, postCommit);
    let publishFailure: string | null = null;
    if (publishAfterCommit) {
      try {
        await this.#publishAfterCommit();
      } catch (thrown) {
        publishFailure = `The change is saved, but the public site does not serve it yet: publishing it failed (${thrown instanceof Error ? thrown.message : String(thrown)}). Do not repeat the change; it is published automatically within seconds once the public database answers.`;
      }
    }
    // #1215 — change hints (the editor's live refresh) hear a handler that
    // answered ok: its change is committed even when a follow-up below
    // failed. A handler's own error left nothing a reader should re-read.
    if (result.ok && !joinedHolder) notifyOperationCommitted(op.name);
    if (effectFailures.length > 0) {
      const effects = postCommitFailureMessage(effectFailures);
      return err({
        kind: "HandlerError",
        operation: op.name,
        message: publishFailure === null ? effects : `${effects} ${publishFailure}`,
      });
    }
    if (publishFailure !== null) {
      return err({ kind: "HandlerError", operation: op.name, message: publishFailure });
    }
    return result;
  }

  /**
   * Issue #1210 — run a `transaction: "none"` op: the branch-visibility gate
   * in its own short transaction, then the handler with no transaction held
   * (operation.ts). Errors map to Results exactly as in {@link runOperation}.
   */
  async #runDetached<I, O>(
    op: OperationDefinition<I, O>,
    ctx: ExecutionContext,
    validatedInput: I,
  ): Promise<Result<O, QueryError>> {
    try {
      const branches = op.database === "cms_admin" ? namedBranches(ctx, validatedInput) : [];
      if (branches.length > 0) {
        const denied = await this.#transaction("admin", op.name, async (tx) => {
          await this.#setIdentity(tx, ctx);
          return firstInvisibleBranch(tx, branches);
        });
        if (denied !== null) return err(branchNotFound(op.name, denied));
      }
      const options = { holder: op.name };
      const runner = detachedRunner(op.name, (fn) =>
        op.database === "cms_admin"
          ? this.withAdminTransaction(ctx, fn, options)
          : this.withPublicTransaction(ctx, fn, options),
      );
      return await op.handler(ctx, validatedInput, runner);
    } catch (thrown) {
      if (thrown instanceof NestedPoolCheckoutError) throw thrown;
      if (thrown instanceof OperationAbortError) return err(thrown.queryError);
      const pgDetail = extractPgFields(thrown);
      return err({
        kind: "HandlerError",
        operation: op.name,
        message: thrown instanceof Error ? thrown.message : String(thrown),
        ...(pgDetail ? { pgDetail } : {}),
      });
    }
  }

  /**
   * Session identity every transaction of this adapter runs under (RLS
   * reads it). One statement, not one per setting: every transaction pays
   * it, and a round-trip per setting made it five (#1212).
   */
  async #setIdentity(tx: TransactionRunner, ctx: ExecutionContext): Promise<void> {
    // P5: the chat-branch / chat-task identity is optional. Snapshot
    // writes read these via ctx.chatBranchId / ctx.chatTaskId; the
    // session vars exist for read-side queries that scope by branch
    // without an extra parameter.
    await tx.execute(sql`SELECT
      set_config('caelo.actor_id', ${ctx.actorId}, true),
      set_config('caelo.actor_kind', ${ctx.actorKind}, true),
      set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true),
      set_config('caelo.chat_branch_id', ${ctx.chatBranchId ?? ""}, true),
      set_config('caelo.chat_task_id', ${ctx.chatTaskId ?? ""}, true)`);
    this.#recordIdentity(tx, ctx);
  }

  /** The cms_public twin of {@link #setIdentity} (no branches there). */
  async #setPublicIdentity(tx: TransactionRunner, ctx: ExecutionContext): Promise<void> {
    await tx.execute(sql`SELECT
      set_config('caelo.actor_id', ${ctx.actorId}, true),
      set_config('caelo.actor_kind', ${ctx.actorKind}, true),
      set_config('caelo.plugin_id', ${ctx.pluginId ?? ""}, true)`);
    this.#recordIdentity(tx, ctx);
  }

  /** Remember `tx`'s identity on its marker, so a joined call can restore it (#1254). */
  #recordIdentity(tx: TransactionRunner, ctx: ExecutionContext): void {
    for (const pool of ["admin", "public"] as const) {
      const marker = this.#guard.held(pool);
      if (marker !== null && marker.tx === tx) marker.identity = ctx;
    }
  }

  /**
   * Issue #1212 — run a {@link ReadOperationDefinition}: the branch gate
   * (#569) in a short transaction of its own (only when the call names a
   * branch), then the handler, whose every `reads.read` is one more short
   * transaction. No connection is held while the handler does anything
   * else (plugin calls, font I/O, composing).
   */
  async #runReadOperation<I, O>(
    op: ReadOperationDefinition<I, O>,
    ctx: ExecutionContext,
    validatedInput: I,
  ): Promise<Result<O, QueryError>> {
    try {
      const branches = namedBranches(ctx, validatedInput);
      if (branches.length > 0) {
        const denied = await this.#shortRead(ctx, op.name, (tx) =>
          firstInvisibleBranch(tx, branches),
        );
        if (denied !== null) return err(branchNotFound(op.name, denied));
      }
      return await op.handler(ctx, validatedInput, this.readScope(ctx, op.name));
    } catch (thrown) {
      // #1210 — a nested checkout is a bug in the code, not an outcome.
      if (thrown instanceof NestedPoolCheckoutError) throw thrown;
      if (thrown instanceof OperationAbortError) return err(thrown.queryError);
      if (isRlsDenial(thrown)) {
        return err({
          kind: "RLSDenied",
          operation: op.name,
          detail: (thrown as { message?: string }).message ?? "RLS policy denied the read",
        });
      }
      const pgDetail = extractPgFields(thrown);
      return err({
        kind: "HandlerError",
        operation: op.name,
        message: thrown instanceof Error ? thrown.message : String(thrown),
        ...(pgDetail ? { pgDetail } : {}),
      });
    }
  }

  /**
   * Issue #1212 — a {@link ReadScope} acting as `ctx`: each read is one
   * short cms_admin transaction under the caller's identity. It does not
   * run the branch gate; a read operation passes it once before its
   * handler receives the scope. Like every transaction of the adapter, a
   * read refuses to run inside a transaction its own call chain holds
   * (#1210).
   *
   * @param holder - names the reader in pool-guard errors.
   */
  readScope(ctx: ExecutionContext, holder = "reads.read"): ReadScope {
    return { read: (fn) => this.#shortRead(ctx, holder, fn) };
  }

  #shortRead<T>(
    ctx: ExecutionContext,
    holder: string,
    fn: (tx: TransactionRunner) => Promise<T>,
  ): Promise<T> {
    return this.#transaction("admin", holder, async (tx) => {
      await this.#setIdentity(tx, ctx);
      return fn(tx);
    });
  }

  /**
   * Issue #585 — run the effects a committed transaction deferred with
   * `afterCommit`. A failure is loud on three channels: an error log, a
   * failed audit row (`<operation>.post_commit`) and the returned list,
   * which the caller turns into an error result.
   */
  async #settlePostCommit(
    operation: string,
    ctx: ExecutionContext,
    effects: ReadonlyArray<PostCommitEffect>,
  ): Promise<PostCommitFailure[]> {
    if (effects.length === 0) return [];
    const failures = await runPostCommitEffects(effects);
    for (const failure of failures) {
      // The operation name stays out of the console line: it is in the
      // audit row, found by `requestId`, and the effect label already says
      // what failed. Logging values derived from the op object would also
      // carry the credential ops' (password, OAuth client) data flow into
      // the log sink, which CodeQL flags as clear-text logging.
      console.error("[query-api] post-commit effect failed", {
        effect: failure.effect.label,
        entityId: failure.effect.entityId ?? null,
        requestId: ctx.requestId,
        error: failure.message,
      });
      if (this.#admin === null) continue;
      try {
        await this.#transaction("admin", `${operation}.post_commit`, async (tx) => {
          await this.#setIdentity(tx, ctx);
          await recordAudit(tx, {
            actorId: ctx.actorId,
            requestId: ctx.requestId,
            operation: `${operation}.post_commit`,
            input: { effect: failure.effect.label },
            succeeded: false,
            entityId: failure.effect.entityId ?? null,
            resultSummary: `${failure.effect.label}: ${failure.message}`.slice(0, 500),
          });
        });
      } catch (thrown) {
        console.error("[query-api] could not audit the failed post-commit effect", {
          effect: failure.effect.label,
          requestId: ctx.requestId,
          error: thrown instanceof Error ? thrown.message : String(thrown),
        });
      }
    }
    return failures;
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
    options: TransactionOptions = {},
  ): Promise<T> {
    const holder = options.holder ?? "withAdminTransaction";
    this.#guard.assertMayCheckout("admin", holder);
    this.#adminDb(holder);
    if (!this.#skipVerify) await this.verifyRoles();
    let publishAfterCommit = false;
    let postCommit: PostCommitEffect[] = [];
    const out = await this.#transaction("admin", holder, async (tx, joined) => {
      if (!joined) postCommit = collectPostCommitEffects(tx);
      await this.#setIdentity(tx, ctx);
      // Issue #569 — same branch-visibility gate as runOperation.
      const denied = await firstInvisibleBranch(tx, namedBranches(ctx, undefined));
      if (denied !== null) {
        throw new OperationAbortError(branchNotFound("withAdminTransaction", denied));
      }
      const result = await fn(tx);
      if (!joined) publishAfterCommit = await this.#projectionDirty(tx);
      return result;
    });
    // #585 — deferred in-process effects, after the commit only.
    const effectFailures = await this.#settlePostCommit(holder, ctx, postCommit);
    // #635 — published state changed: live on the public side before
    // returning. Runs even when an effect failed: the change is committed.
    if (publishAfterCommit) await this.#publishAfterCommit();
    if (effectFailures.length > 0) throw new Error(postCommitFailureMessage(effectFailures));
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
    options: TransactionOptions = {},
  ): Promise<T> {
    const holder = options.holder ?? "withPublicTransaction";
    this.#guard.assertMayCheckout("public", holder);
    if (!this.#skipVerify) await this.verifyRoles();
    let postCommit: PostCommitEffect[] = [];
    const out = await this.#transaction("public", holder, async (tx, joined) => {
      if (!joined) postCommit = collectPostCommitEffects(tx);
      await this.#setPublicIdentity(tx, ctx);
      return await fn(tx);
    });
    const effectFailures = await this.#settlePostCommit(holder, ctx, postCommit);
    if (effectFailures.length > 0) throw new Error(postCommitFailureMessage(effectFailures));
    return out;
  }

  /**
   * Raw access for fixture setup, adversarial direct queries and the few
   * workers that open their own transaction. Refused from inside a
   * transaction of the same pool (issue #1210): a query on the raw pool
   * there is a second checkout.
   */
  rawAdmin(): SQL {
    if (this.#adminRaw === null) throw new AdminDatabaseUnavailableError("rawAdmin");
    this.#guard.assertNoHeldTransaction("admin", "rawAdmin()");
    return this.#adminRaw;
  }
  rawPublic(): SQL {
    this.#guard.assertNoHeldTransaction("public", "rawPublic()");
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
   * Safe to call from several instances at once — see
   * {@link provisionPluginSchemaInTx}.
   */
  async provisionPluginPublicSchema(opts: { pluginId: string; sql: string }): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(opts.pluginId)) {
      throw new Error(`provisionPluginPublicSchema: pluginId "${opts.pluginId}" is not a UUID`);
    }
    if (!this.#skipVerify) await this.verifyRoles();
    const outcome = await this.#transaction("public", "provisionPluginPublicSchema", async (tx) => {
      // The emitted SQL is constructed entirely from validated identifiers
      // (slug regex `^[a-z][a-z0-9-]*$`, table names regex `^[a-z_][a-z0-9_]*$`)
      // and the plugin id is a UUID column from cms_admin.plugins, never user-provided
      // text. `quoteIdent` in plugin-sandbox/src/schema.ts throws on any
      // identifier that doesn't match the safe pattern.
      return provisionPluginSchemaInTx(tx, "provisionPluginPublicSchema", opts);
    });
    if (outcome.droppedColumns.length > 0) {
      // cms_public has no audit log; the drop is recorded on the admin side.
      await this.#transaction("admin", "provisionPluginPublicSchema", async (tx) => {
        await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
        await auditDroppedColumns(tx, "cms_public", opts.pluginId, outcome);
      });
    }
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
    this.#adminDb("provisionPluginAdminSchema");
    if (!this.#skipVerify) await this.verifyRoles();
    await this.#transaction("admin", "provisionPluginAdminSchema", async (tx) => {
      const outcome = await provisionPluginSchemaInTx(tx, "provisionPluginAdminSchema", opts);
      if (outcome.droppedColumns.length > 0) {
        await auditDroppedColumns(tx, "cms_admin", opts.pluginId, outcome);
      }
    });
  }

  /**
   * #389 — drop a plugin's cms_admin schema (uninstall path, #393).
   * Same watertight name gate as the cms_public variant.
   */
  async dropPluginAdminSchema(opts: { schemaName: string }): Promise<void> {
    this.#adminDb("dropPluginAdminSchema");
    if (!this.#skipVerify) await this.verifyRoles();
    if (!/^plugin_[a-z][a-z0-9_]*$/.test(opts.schemaName)) {
      throw new Error(
        `dropPluginAdminSchema: refusing to drop schema "${opts.schemaName}" — name doesn't match plugin_<slug> pattern`,
      );
    }
    await this.#transaction("admin", "dropPluginAdminSchema", async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS "${opts.schemaName}" CASCADE`));
      await tx.execute(
        sql`DELETE FROM plugin_schema_provisions WHERE schema_name = ${opts.schemaName}`,
      );
    });
  }

  async dropPluginPublicSchema(opts: { schemaName: string }): Promise<void> {
    if (!this.#skipVerify) await this.verifyRoles();
    if (!/^plugin_[a-z][a-z0-9_]*$/.test(opts.schemaName)) {
      throw new Error(
        `dropPluginPublicSchema: refusing to drop schema "${opts.schemaName}" — name doesn't match plugin_<slug> pattern`,
      );
    }
    await this.#transaction("public", "dropPluginPublicSchema", async (tx) => {
      await tx.execute(sql.raw("SELECT set_config('caelo.actor_kind', 'system', true)"));
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS "${opts.schemaName}" CASCADE`));
      await tx.execute(
        sql`DELETE FROM plugin_schema_provisions WHERE schema_name = ${opts.schemaName}`,
      );
    });
  }

  /** The drizzle pool handles; refused inside a transaction of the same pool (see {@link rawAdmin}). */
  get admin(): BunSQLDatabase {
    const db = this.#adminDb("admin pool");
    this.#guard.assertNoHeldTransaction("admin", "adapter.admin");
    return db;
  }
  get public(): BunSQLDatabase {
    this.#guard.assertNoHeldTransaction("public", "adapter.public");
    return this.#public;
  }
}

/**
 * #1146 — one audit row per provisioning that dropped columns a new plugin
 * version no longer declares (the data in them is gone for good).
 */
async function auditDroppedColumns(
  tx: TransactionRunner,
  database: "cms_admin" | "cms_public",
  pluginId: string,
  outcome: ProvisionOutcome,
): Promise<void> {
  await recordAudit(tx, {
    actorId: SYSTEM_ACTOR_ID,
    operation: "plugins.schema_drop_columns",
    input: { database, schema: outcome.schemaName, columns: outcome.droppedColumns },
    succeeded: true,
    entityId: pluginId,
    resultSummary: `${database}.${outcome.schemaName}: dropped ${outcome.droppedColumns.join(", ")}`,
  });
}
