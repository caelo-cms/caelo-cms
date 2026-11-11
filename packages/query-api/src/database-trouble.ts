// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1595 — the failures that mean the database, not the caller, is in
 * trouble, as one event per failed transaction.
 *
 * A statement past `statement_timeout`, a lock wait past `lock_timeout`, a
 * session Postgres ended for sitting idle in a transaction (the limits of
 * cms_admin migration 0392) and a caller that found no free pooled
 * connection within the acquire deadline (pool-guard.ts) each say that the
 * admin as a whole stalls. The adapter hands every such failure to its
 * listeners ({@link DatabaseTroubleListener}) with the transaction holder
 * that met it; admin-core's incident capture turns a burst of them into one
 * bug report with a snapshot of who blocks whom. Classification reads the
 * SQLSTATE and the driver's message, never the caller's input.
 */

import { extractPgFields } from "./errors.js";
import { PoolAcquireTimeoutError, type PoolName } from "./pool-guard.js";

/** What kind of database trouble a failed transaction met. */
export type DatabaseTroubleKind =
  /** No pooled connection became free within the acquire deadline. */
  | "pool_wait_timeout"
  /** A statement ran past `statement_timeout` (SQLSTATE 57014). */
  | "statement_timeout"
  /** A lock wait ran past `lock_timeout` (SQLSTATE 55P03). */
  | "lock_timeout"
  /** Postgres ended the session for idling inside a transaction (25P03). */
  | "idle_in_transaction_timeout";

/** One transaction that failed on database trouble. */
export interface DatabaseTrouble {
  readonly kind: DatabaseTroubleKind;
  readonly pool: PoolName;
  /** The op name or `withAdminTransaction` holder label that met it. */
  readonly holder: string;
  /** How long the transaction (including its wait for a connection) had run. */
  readonly elapsedMs: number;
}

/** Called once per failed transaction; must not throw (it is not awaited). */
export type DatabaseTroubleListener = (trouble: DatabaseTrouble) => void;

/** SQLSTATE Postgres sends when it ends an idle-in-transaction session. */
const PG_IDLE_IN_TRANSACTION_TIMEOUT = "25P03";

/** The driver message of `thrown` and its causes, joined (Bun wraps the server error). */
function messages(thrown: unknown): string {
  const out: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") out.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return out.join(" | ");
}

/**
 * The trouble `thrown` stands for, or null for any other failure (a
 * constraint, an RLS denial, a bug in a handler).
 */
export function classifyDatabaseTrouble(thrown: unknown): DatabaseTroubleKind | null {
  if (thrown instanceof PoolAcquireTimeoutError) return "pool_wait_timeout";
  const pg = extractPgFields(thrown);
  if (pg?.timeout === "statement") return "statement_timeout";
  if (pg?.timeout === "lock") return "lock_timeout";
  if (pg?.code === PG_IDLE_IN_TRANSACTION_TIMEOUT) return "idle_in_transaction_timeout";
  // The session is gone when the client learns of it, so Bun may surface a
  // closed connection whose message is all that names the reason.
  if (/idle-in-transaction timeout/i.test(messages(thrown))) return "idle_in_transaction_timeout";
  return null;
}
