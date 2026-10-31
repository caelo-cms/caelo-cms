// SPDX-License-Identifier: MPL-2.0

/**
 * Post-commit effects (issue #585) — in-process side effects a handler
 * wants to happen only once its transaction has COMMITTED.
 *
 * Some writes have a twin outside the database: revoking a plugin's grant
 * flips its row to `disabled` AND must stop it in the running host (tools
 * out of the catalogue, workers paused). Doing the second half inside the
 * handler runs it before the commit, so a rollback (a later statement
 * failing, a serialization error, the commit itself failing) leaves the
 * host disabled while the database still says active — and, the other
 * way round, enabling a plugin in-tx lets it run on state that may never
 * commit. A handler instead registers the effect with {@link afterCommit};
 * the Database Adapter runs it after the commit and drops it on rollback.
 *
 * This is the in-process counterpart of the `domain_events` outbox: the
 * outbox carries signals to OTHER consumers transactionally; this carries
 * the committing process's own follow-up. Effects must be cheap and
 * idempotent — they run on the request path, once, in registration order.
 *
 * A failing effect is never silent: the adapter logs it, writes a failed
 * audit row and turns the op result into an error that says the change
 * itself IS saved (see `DatabaseAdapter.runOperation`).
 */

import type { TransactionRunner } from "./operation.js";

/** One deferred effect. `label` names it in logs, audit rows and errors. */
export interface PostCommitEffect {
  /** Operator-readable description, e.g. `stop plugin "x" in the running host`. */
  readonly label: string;
  /** Audit subject (plugin id, page id …), when there is one. */
  readonly entityId?: string | null;
  readonly run: () => void | Promise<void>;
}

/** An effect that threw after its transaction committed. */
export interface PostCommitFailure {
  readonly effect: PostCommitEffect;
  readonly message: string;
}

const pendingByTx = new WeakMap<TransactionRunner, PostCommitEffect[]>();

/**
 * Defer `effect` until `tx` commits. On rollback it never runs.
 *
 * Throws when `tx` was not opened by the Database Adapter (a nested
 * savepoint transaction, or a raw pool transaction in a test): such a
 * transaction has no commit the adapter could observe, and silently
 * running or dropping the effect would reintroduce the divergence this
 * exists to prevent (CLAUDE.md §2, no fallbacks).
 *
 * @example
 *   afterCommit(tx, {
 *     label: `stop plugin "${slug}" in the running host`,
 *     entityId: pluginId,
 *     run: () => applyPluginLifecycle(slug, "disable"),
 *   });
 */
export function afterCommit(tx: TransactionRunner, effect: PostCommitEffect): void {
  const pending = pendingByTx.get(tx);
  if (pending === undefined) {
    throw new Error(
      `afterCommit(${effect.label}): this transaction was not opened by the Database Adapter, so its commit cannot be observed. Run the handler through execute() / adapter.withAdminTransaction() on the outer transaction.`,
    );
  }
  pending.push(effect);
}

/**
 * Adapter-internal: start collecting effects for `tx`. Returns the live
 * list the adapter drains after commit.
 */
export function collectPostCommitEffects(tx: TransactionRunner): PostCommitEffect[] {
  const pending: PostCommitEffect[] = [];
  pendingByTx.set(tx, pending);
  return pending;
}

/**
 * Adapter-internal: run committed effects in order. Every effect runs even
 * when an earlier one failed — each is an independent consequence of the
 * same commit.
 */
export async function runPostCommitEffects(
  effects: ReadonlyArray<PostCommitEffect>,
): Promise<PostCommitFailure[]> {
  const failures: PostCommitFailure[] = [];
  for (const effect of effects) {
    try {
      await effect.run();
    } catch (thrown) {
      failures.push({
        effect,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  }
  return failures;
}

/**
 * Issue #1215 — a listener that hears the NAME of every operation whose
 * transaction committed successfully in this process. It exists for change
 * hints that have no single handler to live in (the editor's live refresh:
 * "a proposal changed, re-read the pending strip" spans ~70 propose /
 * execute / reject ops). The listener classifies by name and never sees
 * inputs, outputs or the actor, so it cannot carry data between callers.
 * It runs after the commit and the post-commit effects; it must be cheap,
 * and a throw is logged and ignored — the operation itself succeeded, and a
 * hint never changes its result.
 */
export type CommittedOperationListener = (operationName: string) => void;

const committedListeners = new Set<CommittedOperationListener>();

/**
 * Hear every successfully committed operation of this process.
 *
 * @returns the unsubscribe function.
 * @example
 *   const stop = observeCommittedOperations((name) => {
 *     if (name.endsWith(".execute_proposal")) markPendingChanged();
 *   });
 */
export function observeCommittedOperations(listener: CommittedOperationListener): () => void {
  committedListeners.add(listener);
  return () => {
    committedListeners.delete(listener);
  };
}

/** Adapter-internal: tell every listener that `operationName` committed. */
export function notifyOperationCommitted(operationName: string): void {
  for (const listener of committedListeners) {
    try {
      listener(operationName);
    } catch (thrown) {
      console.error(`[query-api] committed-operation listener failed for ${operationName}`, thrown);
    }
  }
}

/**
 * Issue #1267 — what a committing operation tells OTHER instances: a NOTIFY
 * the adapter sends inside the operation's transaction, so it is delivered
 * exactly when the transaction commits and never on rollback. The live
 * fan-out registers one ({@link setCommitNotice}) that maps an op name to
 * its live topics; the adapter stays ignorant of topics.
 */
export interface CommitNotice {
  readonly channel: string;
  readonly payload: string;
}

/** Maps a committing operation's name to its notice, or null for none. */
export type CommitNoticeSource = (operationName: string) => CommitNotice | null;

let commitNotice: CommitNoticeSource | null = null;

/**
 * Register the process's commit notice (one per process; the admin's live
 * fan-out). Pass null to remove it.
 *
 * @example
 *   setCommitNotice((name) => {
 *     const topics = liveTopicsOfOperation(name);
 *     return topics.length ? { channel: "caelo_live_topics", payload: `${me}|${topics}` } : null;
 *   });
 */
export function setCommitNotice(source: CommitNoticeSource | null): void {
  commitNotice = source;
}

/** Adapter-internal: the notice `operationName` sends on commit, if any. */
export function commitNoticeOf(operationName: string): CommitNotice | null {
  return commitNotice === null ? null : commitNotice(operationName);
}
