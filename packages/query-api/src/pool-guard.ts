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
 * `transaction: "none"`). {@link NESTED_CHECKOUT_ALLOWLIST} names the
 * holders still being fixed; each entry points at its issue.
 */

import { AsyncLocalStorage } from "node:async_hooks";
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
 * What an allowlisted holder may still do while issue `issue` is open:
 * take further checkouts of the same pool from inside its transaction
 * (`nestedCheckouts`), and run without the role timeouts of migration 0392
 * (`noSessionTimeouts`) because its transaction stays open across a build or
 * an upload that takes longer than they allow.
 */
export interface AllowlistEntry {
  /** The op name, or the `holder` label a `withAdminTransaction` caller passes. */
  readonly holder: string;
  readonly issue: number;
  readonly nestedCheckouts: boolean;
  readonly noSessionTimeouts: boolean;
}

/**
 * Transaction holders that still take a second checkout of their own pool.
 * Each one is a known deadlock risk being removed by its issue; nothing may
 * be added without one (CLAUDE.md §4). A nested checkout from an entry's
 * chain is let through, every other one throws.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  // FIXME(issue #1220): a plugin's onActivate runs while this transaction
  // holds the per-plugin advisory lock (plugin-host activation-lock.ts);
  // the plugin's storage writes open their own transactions.
  {
    holder: "plugins.activation_lock",
    issue: 1220,
    nestedCheckouts: true,
    noSessionTimeouts: false,
  },
  // FIXME(issue #1220): the static generator reads the whole site in one
  // transaction for as long as the build takes, and its plugin pass reads
  // and writes the bake cache (static_bakes) in transactions of its own.
  { holder: "static-generator.build", issue: 1220, nestedCheckouts: true, noSessionTimeouts: true },
  // FIXME(issue #1220): a call site, not a holder (see
  // allowNestedCheckouts): render-origin plugin operations — URL
  // annotations while a page write composes paths, list sources, public
  // URLs — run inside the calling op's transaction, and the plugin's
  // storage reads and failure audit rows are ops of their own.
  { holder: "plugins.render_hook", issue: 1220, nestedCheckouts: true, noSessionTimeouts: false },
];

/** {@link ALLOWLIST} by holder. */
export const NESTED_CHECKOUT_ALLOWLIST: ReadonlyMap<string, AllowlistEntry> = new Map(
  ALLOWLIST.map((entry) => [entry.holder, entry]),
);

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
  /** The allowlisted holder further up this chain, if any. */
  readonly allowedBy: string | null;
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
 * Call sites on the allowlist (see {@link allowNestedCheckouts}). Shared by
 * every adapter of the process: the call site does not know which adapter
 * its plugin work reaches.
 */
const allowances = new AsyncLocalStorage<string>();

/**
 * Run `fn` with nested checkouts allowed for whatever transaction its
 * caller holds — for a call site that runs inside many different holders
 * (a plugin render hook called from every page write). `label` must be an
 * allowlist entry, so each such call site is tied to its issue.
 *
 * @throws Error when `label` is not on the allowlist.
 */
export function allowNestedCheckouts<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (NESTED_CHECKOUT_ALLOWLIST.get(label)?.nestedCheckouts !== true) {
    throw new Error(`allowNestedCheckouts: "${label}" is not on the nested-checkout allowlist`);
  }
  return allowances.run(label, fn);
}

/** Per-pool chain markers of one adapter. */
export class PoolGuard {
  readonly #stores: Record<PoolName, AsyncLocalStorage<HeldTransaction>> = {
    admin: new AsyncLocalStorage(),
    public: new AsyncLocalStorage(),
  };

  /**
   * The marker a new transaction of `pool` opened by `holder` runs under.
   *
   * @throws NestedPoolCheckoutError when this chain already holds a
   *   transaction of `pool` and no allowlisted holder sits above it.
   */
  enter(pool: PoolName, holder: string): HeldTransaction {
    const allowedBy = this.assertMayCheckout(pool, holder);
    return { holder, active: true, allowedBy };
  }

  /**
   * Refuse a checkout of `pool` by `requester` while this chain holds a
   * transaction of it. Returns the allowlisted holder that lets it through,
   * or null when the chain holds no transaction of `pool`.
   *
   * @throws NestedPoolCheckoutError as {@link enter}.
   */
  assertMayCheckout(pool: PoolName, requester: string): string | null {
    const outer = this.#stores[pool].getStore();
    if (outer === undefined || !outer.active) return null;
    const allowedBy =
      outer.allowedBy ??
      (NESTED_CHECKOUT_ALLOWLIST.get(outer.holder)?.nestedCheckouts ? outer.holder : null) ??
      allowances.getStore() ??
      null;
    if (allowedBy === null) throw new NestedPoolCheckoutError(pool, outer.holder, requester);
    return allowedBy;
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

/**
 * Whether `holder` runs without the role timeouts (see
 * {@link AllowlistEntry.noSessionTimeouts}).
 */
export function exemptFromSessionTimeouts(holder: string): boolean {
  return NESTED_CHECKOUT_ALLOWLIST.get(holder)?.noSessionTimeouts === true;
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
