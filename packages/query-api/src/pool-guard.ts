// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1210 — no code path may hold a pooled connection while it waits for
 * a second one from the same pool.
 *
 * Bun.SQL has no acquire timeout. When every connection of a pool is held by
 * a transaction whose own call chain then asks the same pool for another
 * connection, nothing is ever released: the pool deadlocks for good while
 * the database idles (production, 2026-10-28: cms_admin at exactly the pool
 * cap of 10, every backend `idle in transaction`, requests hung for minutes).
 * One such transaction needs only `max` concurrent callers to take the whole
 * admin down, so the class is refused outright, not tuned around:
 *
 *  - every transaction the adapter opens marks its async call chain with a
 *    {@link HeldTransaction} (one `AsyncLocalStorage` per pool). Entering
 *    the same pool again from that chain — another op through `execute()`,
 *    `withAdminTransaction`, the raw pool handles — throws
 *    {@link NestedPoolCheckoutError} naming both sides before it waits;
 *  - every checkout waits at most {@link POOL_ACQUIRE_TIMEOUT_MS} for a free
 *    connection and then fails with {@link PoolAcquireTimeoutError}, so even
 *    a path the guard cannot see (another process, a leaked connection)
 *    fails in seconds instead of hanging.
 *
 * The fix for a flagged caller is always the same: pass the holder's `tx` to
 * the inner work (compose op handlers with `op.handler(ctx, input, tx)`), or
 * do the inner work outside the holder's transaction (a detached op,
 * `transaction: "none"`).
 *
 * Render-time plugin work (#1254, completing #1220) is the one place that
 * reaches the pool from inside many different holders: a page write
 * composes paths, and the URL plugins' annotation ops read their storage
 * through ops of their own. Such a call does not take a second connection;
 * it JOINS the holder's transaction ({@link joinHeldTransaction}): each of
 * its transactions becomes a SAVEPOINT of the holder's, runs under its own
 * identity and is serialised with its siblings, and the holder's identity
 * is restored when it releases. Only a call site that opts in joins, so an
 * unexpected nested checkout still throws.
 *
 * {@link LONG_TRANSACTION_ALLOWLIST} names holders whose one transaction
 * legitimately outlasts the role timeouts of migration 0392 and runs
 * without them. Being on it allows no nested checkout. Each entry says why
 * its transaction is long; a temporary one also names its issue.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { TransactionRunner } from "./operation.js";

/** Which of the adapter's two pools a checkout targets. */
export type PoolName = "admin" | "public";

/**
 * Milliseconds a caller waits for a free pooled connection before it fails.
 * A healthy request holds a connection for milliseconds; ten seconds of
 * waiting means the pool is exhausted, and answering then — instead of
 * queueing the request for minutes behind connections that may never come
 * back — is what lets the editor (and the AI) see a clear failure.
 */
export const POOL_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * A holder whose transaction runs without the role timeouts of migration
 * 0392 (statement, lock and idle-in-transaction), because it stays open
 * across a build or an upload that takes longer than they allow.
 */
export interface LongTransactionEntry {
  /** The op name, or the `holder` label a `withAdminTransaction` caller passes. */
  readonly holder: string;
  /** Why this transaction is long — what would break if it were cut short. */
  readonly reason: string;
  /** Set when the long transaction itself is being removed (a FIXME). */
  readonly issue?: number;
}

/**
 * Transaction holders that run without the 0392 timeouts. Nothing may be
 * added without a written reason; a temporary entry names its issue.
 */
const LONG_TRANSACTIONS: readonly LongTransactionEntry[] = [
  {
    // Not temporary: a site build runs in one transaction from its first
    // read to its last bake-cache write — minutes on a large site, idle
    // while plugins render through the admin and files are written. It
    // runs in the generator subprocess on a pool of its own and takes no
    // second checkout of it (the bake cache rides on this transaction,
    // static-generator plugin-pass.ts).
    holder: "static-generator.build",
    reason:
      "a static site build runs in one transaction for as long as the build takes, idle while plugins render and files are written.",
  },
  {
    // Not temporary (#1254): the admin answers every plugin call of a
    // build (link and list resolution, head contributions, URLs, static
    // renders) on ONE connection — each call joins this transaction as a
    // savepoint — instead of a checkout per plugin read. It lasts as long
    // as the build and idles between the generator's calls.
    holder: "static-generator.plugin-calls",
    reason:
      "the admin side of a static build answers every plugin call on one transaction that stays open, idle between calls, until the build ends.",
  },
];

/** {@link LONG_TRANSACTIONS} by holder. */
export const LONG_TRANSACTION_ALLOWLIST: ReadonlyMap<string, LongTransactionEntry> = new Map(
  LONG_TRANSACTIONS.map((entry) => [entry.holder, entry]),
);

/**
 * Runs queued callbacks one at a time. A joined transaction is a savepoint
 * on ONE connection, so two of them interleaving (two plugin reads started
 * together) would release each other's savepoints and run under each
 * other's identity.
 */
class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/** The marker a transaction leaves on its async call chain. */
export interface HeldTransaction {
  /** The op name or `withAdminTransaction` holder label that opened it. */
  readonly holder: string;
  /**
   * False once the transaction ended. Work the transaction started but did
   * not await (a timer, a fire-and-forget promise) keeps the marker in its
   * async context; it holds no connection any more and must pass.
   */
  active: boolean;
  /** The open transaction (a savepoint for a joined one); set once BEGIN ran. */
  tx: TransactionRunner | null;
  /** The identity the transaction runs under, restored after a joined call. */
  identity: ExecutionContext | null;
  /** The real transaction a joined marker's savepoint belongs to; null on a root. */
  readonly root: HeldTransaction | null;
  /** Serialises the joined calls made directly under this transaction. */
  readonly joined: SerialQueue;
  /** Root only: work deferred until the transaction ended ({@link PoolGuard.deferUntilEnd}). */
  readonly afterEnd: Array<() => Promise<void>>;
}

/**
 * Thrown when a call chain that holds a transaction of a pool asks the same
 * pool for another connection (see the file header). Always a bug in the
 * caller, never a condition to retry.
 */
export class NestedPoolCheckoutError extends Error {
  override readonly name = "NestedPoolCheckoutError";
  constructor(
    readonly pool: PoolName,
    readonly holder: string,
    readonly requester: string,
  ) {
    super(
      `${requester} asked the ${pool} database pool for a second connection while ${holder} holds a transaction of that pool in the same call chain. ` +
        "Enough of these at once deadlock the whole pool (issue #1210), so it is refused. Nothing of this call ran. " +
        `Fix in the code: pass ${holder}'s transaction to the inner work (op.handler(ctx, input, tx)) or move the inner work out of the transaction (transaction: "none").`,
    );
  }
}

/**
 * Thrown when no pooled connection became free within the acquire deadline.
 * The request did nothing; the message tells the caller (often the AI) what
 * to do next.
 */
export class PoolAcquireTimeoutError extends Error {
  override readonly name = "PoolAcquireTimeoutError";
  constructor(
    readonly pool: PoolName,
    readonly requester: string,
    readonly timeoutMs: number,
  ) {
    super(
      `the ${pool} database pool had no free connection for ${requester} within ${timeoutMs} ms: every connection is busy. ` +
        "Nothing was changed. Retry in a few seconds; if it keeps happening the admin is overloaded or a request holds its connections — the server log names it.",
    );
  }
}

/**
 * Call chains that join the transaction their caller holds (see
 * {@link joinHeldTransaction}). Shared by every adapter of the process: the
 * call site does not know which adapter its plugin work reaches.
 */
const joining = new AsyncLocalStorage<true>();

/**
 * Run `fn` so that every transaction it opens on a pool its call chain
 * already holds JOINS that transaction as a savepoint instead of asking the
 * pool for a second connection (#1254). For render-time plugin work: it
 * runs inside whatever op composes a page, only reads, and must see the
 * holder's uncommitted writes. Outside a held transaction `fn` checks out
 * connections as usual.
 */
export function joinHeldTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return joining.run(true, fn);
}

/** What a new transaction of a pool does: open its own, or join the held one. */
export type TransactionPlan =
  | { readonly kind: "own"; readonly marker: HeldTransaction }
  | { readonly kind: "join"; readonly outer: HeldTransaction; readonly marker: HeldTransaction };

function newMarker(holder: string, root: HeldTransaction | null): HeldTransaction {
  return {
    holder,
    active: true,
    tx: null,
    identity: null,
    root,
    joined: new SerialQueue(),
    afterEnd: [],
  };
}

/** Per-pool chain markers of one adapter. */
export class PoolGuard {
  readonly #stores: Record<PoolName, AsyncLocalStorage<HeldTransaction>> = {
    admin: new AsyncLocalStorage(),
    public: new AsyncLocalStorage(),
  };

  /**
   * How a new transaction of `pool` opened by `holder` runs: on its own
   * connection, or joined to the transaction the chain holds.
   *
   * @throws NestedPoolCheckoutError when this chain already holds a
   *   transaction of `pool` and does not join it.
   */
  plan(pool: PoolName, holder: string): TransactionPlan {
    const outer = this.held(pool);
    if (outer === null) return { kind: "own", marker: newMarker(holder, null) };
    this.assertMayCheckout(pool, holder);
    return { kind: "join", outer, marker: newMarker(holder, outer.root ?? outer) };
  }

  /** The active transaction this chain holds on `pool`, or null. */
  held(pool: PoolName): HeldTransaction | null {
    const outer = this.#stores[pool].getStore();
    return outer?.active ? outer : null;
  }

  /**
   * Refuse a checkout of `pool` by `requester` while this chain holds a
   * transaction of it, unless the chain joins it ({@link joinHeldTransaction}).
   *
   * @throws NestedPoolCheckoutError as {@link plan}.
   */
  assertMayCheckout(pool: PoolName, requester: string): void {
    const outer = this.held(pool);
    if (outer === null || joining.getStore() === true) return;
    throw new NestedPoolCheckoutError(pool, outer.holder, requester);
  }

  /**
   * Refuse a RAW handle of `pool` while the chain holds a transaction of
   * it: a raw query has no transaction to join, so it always is a second
   * checkout.
   *
   * @throws NestedPoolCheckoutError naming both sides.
   */
  assertNoHeldTransaction(pool: PoolName, requester: string): void {
    const outer = this.held(pool);
    if (outer !== null) throw new NestedPoolCheckoutError(pool, outer.holder, requester);
  }

  /**
   * Run `work` once the transaction this chain holds on `pool` ended
   * (committed or rolled back) and released its connection, or right away
   * when the chain holds none. For writes that must not ride on the
   * holder's transaction: a plugin failure record that has to survive the
   * holder's rollback, written from inside a joined render call.
   *
   * @returns true when `work` was deferred, false when it ran now.
   */
  /**
   * A runner that puts `fn` on THIS chain's held transaction of `pool` and
   * lets it join, from any async context — for work that arrives later on
   * another chain (a callback, a message) but must run on this transaction.
   *
   * @throws Error when the chain holds no transaction of `pool`.
   */
  bindHeld(pool: PoolName): <T>(fn: () => Promise<T>) => Promise<T> {
    const marker = this.held(pool);
    if (marker === null) {
      throw new Error(`bindHeld: this call chain holds no ${pool} transaction to bind to`);
    }
    return (fn) => {
      if (!marker.active) {
        return Promise.reject(
          new Error(
            `the ${pool} transaction of ${marker.holder} already ended; nothing can join it`,
          ),
        );
      }
      return joining.run(true, () => this.#stores[pool].run(marker, fn));
    };
  }

  async deferUntilEnd(pool: PoolName, work: () => Promise<void>): Promise<boolean> {
    const outer = this.held(pool);
    if (outer === null) {
      await work();
      return false;
    }
    (outer.root ?? outer).afterEnd.push(work);
    return true;
  }

  /** Run `fn` with `marker` on its call chain; the marker ends with `fn`. */
  async run<T>(pool: PoolName, marker: HeldTransaction, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.#stores[pool].run(marker, fn);
    } finally {
      marker.active = false;
    }
  }
}

/** Whether `holder` runs without the role timeouts ({@link LONG_TRANSACTION_ALLOWLIST}). */
export function exemptFromSessionTimeouts(holder: string): boolean {
  return LONG_TRANSACTION_ALLOWLIST.has(holder);
}

/**
 * Switch the migration-0392 timeouts off for the rest of `tx` only
 * (`set_config(..., true)` is `SET LOCAL`): the next transaction on the
 * connection is back under them.
 */
export async function liftSessionTimeouts(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`SELECT set_config('statement_timeout', '0', true)`);
  await tx.execute(sql`SELECT set_config('lock_timeout', '0', true)`);
  await tx.execute(sql`SELECT set_config('idle_in_transaction_session_timeout', '0', true)`);
}

/**
 * The `tx` a detached op's handler (`transaction: "none"`) receives. It
 * holds no transaction: `tx.transaction(fn)` opens a short one of its own
 * (with the op's identity, like every op transaction) and ends it when `fn`
 * returns — on a real transaction the same call is a savepoint, so a helper
 * reads the same either way. Every other use throws, naming the op: a
 * detached handler never runs a statement outside a transaction it can see.
 *
 * @param open - opens one short transaction of the op's pool.
 */
export function detachedRunner(
  operation: string,
  open: <T>(fn: (tx: TransactionRunner) => Promise<T>) => Promise<T>,
): TransactionRunner {
  const transaction = <T>(fn: (tx: TransactionRunner) => Promise<T>): Promise<T> => open(fn);
  return new Proxy({} as TransactionRunner, {
    get(_target, property) {
      if (property === "transaction") return transaction;
      // Promise resolution probes `then`; answering it keeps the runner
      // from being mistaken for a thenable when it is passed around.
      if (property === "then") return undefined;
      throw new Error(
        `${operation} is a detached operation (transaction: "none") and holds no transaction; it used tx.${String(property)}. Wrap the step in tx.transaction(async (t) => …) or run it as its own operation.`,
      );
    },
  });
}
