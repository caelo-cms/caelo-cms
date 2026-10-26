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
  /**
   * What the caller should do when the effect fails, when that is not the
   * default (restart the admin so the running state is rebuilt) — e.g. an
   * effect with its own durable retry says it is retried and where its
   * status shows.
   */
  readonly nextStep?: string;
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
