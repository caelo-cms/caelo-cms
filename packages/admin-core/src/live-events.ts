// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the admin's in-process hub of live-refresh topics: "the
 * pending approvals changed", "an agent started", "the quality audit
 * settled". It replaces the editor's timer polling (CLAUDE.md §11.B: clients
 * must not poll the admin on a timer).
 *
 * Where topics come from: every operation that commits in this process is
 * classified by NAME (`liveTopicsOfOperation` in @caelo-cms/shared) through
 * the Query API's `observeCommittedOperations`. No handler has to remember to
 * announce its change, and nothing but a topic name leaves the hub.
 *
 * Who hears them:
 * - the chat stream (`/content/chat/<id>/stream`) forwards them to the tab
 *   whose turn runs, as `{kind: "live", topics}` events;
 * - `/api/live-events` holds one bounded request while a tab waits on work
 *   that is in progress (an audit, an external agent, a crawl) and answers
 *   with the first topics that arrive.
 *
 * What it deliberately is not: there is no timer here and no database
 * connection. A waiter costs one pending promise and one deadline. Topics
 * from ANOTHER admin instance do not arrive (there is no cross-instance
 * channel); a waiter that times out answers `[]`, and the client then
 * re-reads the one surface whose state made it wait.
 */

import { observeCommittedOperations } from "@caelo-cms/query-api";
import { type LiveTopic, liveTopicsOfOperation } from "@caelo-cms/shared";

/** Hears a batch of topics (never empty). */
export type LiveTopicListener = (topics: readonly LiveTopic[]) => void;

const listeners = new Set<LiveTopicListener>();
let observing = false;

function ensureObserving(): void {
  if (observing) return;
  observing = true;
  // Registered once per process and never removed: with no listener the
  // publish below is a loop over an empty set.
  observeCommittedOperations((name) => {
    const topics = liveTopicsOfOperation(name);
    if (topics.length > 0) publishLiveTopics(topics);
  });
}

/**
 * Hear every topic published in this process from now on.
 *
 * @returns the unsubscribe function; call it when the request ends.
 */
export function subscribeLiveTopics(listener: LiveTopicListener): () => void {
  ensureObserving();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Announce `topics` to every listener of this process. A listener that throws is logged. */
export function publishLiveTopics(topics: readonly LiveTopic[]): void {
  if (topics.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(topics);
    } catch (thrown) {
      console.error("[live-events] listener failed", thrown);
    }
  }
}

/** Options of {@link waitForLiveTopics}. */
export interface WaitForLiveTopicsOptions {
  /** Give up after this long and answer `[]`. */
  readonly timeoutMs: number;
  /**
   * After the first matching topic, keep collecting for this long so one
   * burst of commits (a proposal written and its audit row) answers once.
   */
  readonly settleMs?: number;
  /** The request went away: stop waiting and answer `[]`. */
  readonly signal?: AbortSignal;
}

/**
 * Wait until one of `wanted` is published in this process, then answer the
 * wanted topics seen (sorted). Answers `[]` on timeout or abort. Holds no
 * database connection and runs no loop: one listener, one deadline.
 */
export function waitForLiveTopics(
  wanted: readonly LiveTopic[],
  options: WaitForLiveTopicsOptions,
): Promise<LiveTopic[]> {
  const wantedSet = new Set(wanted);
  const seen = new Set<LiveTopic>();
  return new Promise<LiveTopic[]>((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(deadline);
      if (settleTimer !== null) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve([...seen].sort());
    };
    const onAbort = () => {
      seen.clear();
      finish();
    };
    const unsubscribe = subscribeLiveTopics((topics) => {
      let matched = false;
      for (const t of topics) {
        if (wantedSet.has(t)) {
          seen.add(t);
          matched = true;
        }
      }
      if (!matched || settleTimer !== null) return;
      const settleMs = options.settleMs ?? 0;
      if (settleMs <= 0) finish();
      else settleTimer = setTimeout(finish, settleMs);
    });
    const deadline = setTimeout(finish, options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
