// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job's database queue over Cloud SQL IAM authentication,
 * reopened before its access token runs out (#815).
 *
 * The job's password IS a metadata-server access token, which lives about
 * an hour — and the metadata server may hand out one with only minutes
 * left. A pool keeps the password it was opened with, so a connection it
 * opens after the token expired (the pool reconnects whenever an idle
 * connection was closed, e.g. after a long migration step) fails to log
 * in: the job could not record its end, and the request stayed "running".
 *
 * So every queue call first checks the token: once it is within
 * {@link TOKEN_REFRESH_MARGIN_MS} of expiry, a fresh token is fetched and a
 * new pool opened with it. The old pool is closed once its in-flight calls
 * have settled, never under them. Connections already open keep working
 * after expiry (Postgres checks the password only at login), so this is
 * only about connections that do not exist yet.
 */

import type { UpdateQueue } from "@caelo-cms/provisioning";

/** Reopen when the token has less than this left. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** A metadata-server access token and when it expires (epoch ms). */
export interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** A queue over one pool, and how to close that pool. */
export interface OpenedQueue {
  readonly queue: UpdateQueue;
  close(): Promise<void>;
}

export interface TokenQueueDeps {
  readonly fetchToken: () => Promise<AccessToken>;
  /** Open a pool whose password is `token`. */
  readonly open: (token: string) => OpenedQueue;
  readonly now: () => number;
  /** Told about a failed close of a retired pool (it does not fail the run). */
  readonly onCloseError?: (e: unknown) => void;
}

interface Pool {
  readonly token: string;
  readonly opened: OpenedQueue;
  readonly expiresAt: number;
  inFlight: number;
  retired: boolean;
}

/**
 * Parse the metadata server's token response
 * (`instance/service-accounts/default/token`).
 *
 * @param fetchedAt when the response arrived (epoch ms); `expires_in` counts from it
 * @throws when the response names no token or no lifetime — guessing a
 *   lifetime would bring back the very expiry this guards against
 */
export function parseMetadataToken(text: string, fetchedAt: number): AccessToken {
  const body = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("the metadata server returned no access token");
  }
  if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)) {
    throw new Error("the metadata server's access token names no lifetime (expires_in)");
  }
  return { token: body.access_token, expiresAt: fetchedAt + body.expires_in * 1000 };
}

/**
 * An {@link UpdateQueue} that opens its pool with a fresh token whenever the
 * current one is about to expire. `close` closes every pool still open.
 *
 * @example
 *   const q = tokenRefreshingQueue({ fetchToken, open: (t) => openPool(t), now: Date.now });
 *   await q.queue.claim(execution);
 *   await q.close();
 */
export function tokenRefreshingQueue(deps: TokenQueueDeps): {
  readonly queue: UpdateQueue;
  close(): Promise<void>;
} {
  let current: Pool | null = null;
  let opening: Promise<Pool> | null = null;
  const pools = new Set<Pool>();

  const closePool = async (pool: Pool): Promise<void> => {
    pools.delete(pool);
    try {
      await pool.opened.close();
    } catch (e) {
      deps.onCloseError?.(e);
    }
  };

  const fresh = async (): Promise<Pool> => {
    const token = await deps.fetchToken();
    // The metadata server rotates its cached token shortly before expiry;
    // until it has, the same token comes back and the pool stays.
    if (current && current.token === token.token) return current;
    const pool: Pool = {
      token: token.token,
      opened: deps.open(token.token),
      expiresAt: token.expiresAt,
      inFlight: 0,
      retired: false,
    };
    pools.add(pool);
    const old = current;
    current = pool;
    if (old) {
      old.retired = true;
      if (old.inFlight === 0) await closePool(old);
    }
    return pool;
  };

  const pool = async (): Promise<Pool> => {
    if (current && current.expiresAt - deps.now() > TOKEN_REFRESH_MARGIN_MS) return current;
    // One refresh at a time: concurrent calls share it.
    opening ??= fresh().finally(() => {
      opening = null;
    });
    return opening;
  };

  const call = async <T>(use: (q: UpdateQueue) => Promise<T>): Promise<T> => {
    const p = await pool();
    p.inFlight += 1;
    try {
      return await use(p.opened.queue);
    } finally {
      p.inFlight -= 1;
      if (p.retired && p.inFlight === 0 && pools.has(p)) await closePool(p);
    }
  };

  return {
    queue: {
      claim: (execution) => call((q) => q.claim(execution)),
      event: (id, phase, level, message) => call((q) => q.event(id, phase, level, message)),
      record: (id, facts) => call((q) => q.record(id, facts)),
      finish: (id, end) => call((q) => q.finish(id, end)),
    },
    close: async () => {
      await Promise.all([...pools].map(closePool));
      current = null;
    },
  };
}
