// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1375 — how busy each of the adapter's pools is, so a caller that
 * can wait (an external MCP agent) is told to come back instead of joining
 * a queue that will not move.
 *
 * Bun.SQL keeps no count of the callers waiting for a connection, and the
 * pool guard's 10 s acquire deadline (pool-guard.ts) only fails a waiter
 * once it has waited. Under sustained parallel load (production,
 * 2026-11-03: ten Power-MCP sessions on one admin instance) every new
 * request waited those 10 s, failed, and was sent again by its agent, so
 * the queue never drained and the admin answered nothing — reads included
 * — for 30–45 minutes. The adapter counts its own checkouts here: who is
 * waiting since when, and which holder has held a connection for how long.
 * The answer is a snapshot; nothing in here blocks or limits.
 */

import type { PoolName } from "./pool-guard.js";

/**
 * Bun.SQL's pool size when none is configured (a local dev server; every
 * provisioned service sets `CAELO_DB_POOL_MAX`, #1254).
 */
export const BUN_DEFAULT_POOL_MAX = 10;

/** One connection checked out of a pool, by whom and for how long. */
export interface PoolHolding {
  /** The op name or `withAdminTransaction` holder label. */
  readonly holder: string;
  readonly heldMs: number;
}

/** A snapshot of one pool's demand (see {@link PoolDemand}). */
export interface PoolPressure {
  readonly pool: PoolName;
  /** Connections the pool may open. */
  readonly max: number;
  /** Transactions holding a connection right now. */
  readonly inUse: number;
  /** Callers waiting for a free connection right now. */
  readonly waiting: number;
  /** How long the longest-waiting caller has waited (0 when none waits). */
  readonly oldestWaitMs: number;
  /** The current holders, longest-held first. */
  readonly holders: readonly PoolHolding[];
}

/** Counts the waiters and holders of one pool. */
export class PoolDemand {
  readonly #pool: PoolName;
  readonly #max: number;
  readonly #now: () => number;
  #next = 0;
  /** Waiter id → when it started waiting; insertion order = wait order. */
  readonly #waiting = new Map<number, number>();
  /** Holding id → holder and since when. */
  readonly #holding = new Map<number, { readonly holder: string; readonly since: number }>();

  constructor(pool: PoolName, max: number, now: () => number = Date.now) {
    this.#pool = pool;
    this.#max = max;
    this.#now = now;
  }

  /**
   * Record a caller starting to wait for a connection.
   *
   * @returns a function that ends the wait — call it exactly once, whether
   *   the connection came or the wait failed.
   */
  beginWait(): () => void {
    const id = this.#next++;
    this.#waiting.set(id, this.#now());
    return () => {
      this.#waiting.delete(id);
    };
  }

  /**
   * Record `holder` holding a connection.
   *
   * @returns a function that ends the holding — call it when the connection
   *   is released.
   */
  beginHold(holder: string): () => void {
    const id = this.#next++;
    this.#holding.set(id, { holder, since: this.#now() });
    return () => {
      this.#holding.delete(id);
    };
  }

  /** The pool's demand right now. */
  snapshot(): PoolPressure {
    const now = this.#now();
    const firstWait = this.#waiting.values().next();
    const holders = [...this.#holding.values()]
      .map((h) => ({ holder: h.holder, heldMs: now - h.since }))
      .sort((a, b) => b.heldMs - a.heldMs);
    return {
      pool: this.#pool,
      max: this.#max,
      inUse: this.#holding.size,
      waiting: this.#waiting.size,
      oldestWaitMs: firstWait.done ? 0 : now - firstWait.value,
      holders,
    };
  }
}
