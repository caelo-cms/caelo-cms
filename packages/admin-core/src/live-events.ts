// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the admin's in-process hub of live-refresh topics: "the
 * pending approvals changed", "an agent started", "the quality audit
 * settled". It replaces the editor's timer polling (CLAUDE.md §11.B: clients
 * must not poll the admin on a timer).
 *
 * Where topics come from:
 * - every operation that commits in this process is classified by NAME
 *   (`liveTopicsOfOperation` in @caelo-cms/shared) through the Query API's
 *   `observeCommittedOperations`. No handler has to remember to announce its
 *   change, and nothing but a topic name leaves the hub;
 * - operations that committed on ANOTHER admin instance arrive through the
 *   cross-instance fan-out ({@link startLiveFanOut}, issue #1267): each
 *   committing transaction NOTIFYs its topics, every instance LISTENs;
 * - the `draft` topic comes from the change journal: a committed change to
 *   a journaled row, wherever it was made, wakes every instance, which reads
 *   the journal from its own cursor (the cursor is the truth, the
 *   notification only a wake-up).
 *
 * Who hears them:
 * - the chat stream (`/content/chat/<id>/stream`) forwards them to the tab
 *   whose turn runs, as `{kind: "live", topics}` events;
 * - `/api/live-events` holds one bounded request while a tab waits on work
 *   that is in progress (an audit, an external agent, a crawl) and answers
 *   with the first topics that arrive.
 *
 * What it deliberately is not: there is no timer here. A waiter costs one
 * pending promise and one deadline. The fan-out holds one LISTEN connection
 * per instance (`LISTEN_CONNECTIONS_PER_INSTANCE`) and reads the journal only
 * when woken. On a request-billed instance (`cpuIdle`) a wake-up is handled
 * while the instance serves requests, which is when an editor's stream or
 * wait is open.
 */

import {
  currentJournalCursor,
  type DatabaseAdapter,
  type JournalChange,
  type ListenHandle,
  observeCommittedOperations,
  readChanges,
  setCommitNotice,
} from "@caelo-cms/query-api";
import {
  isLiveTopic,
  JOURNAL_CHANNEL,
  JOURNAL_KINDS,
  LIVE_TOPICS,
  LIVE_TOPICS_CHANNEL,
  type LiveTopic,
  liveTopicsOfOperation,
} from "@caelo-cms/shared";

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

/** Hears the journal rows another write committed (server-side consumers, #1270). */
export type EntityChangeListener = (changes: readonly JournalChange[]) => void;

const entityListeners = new Set<EntityChangeListener>();

/**
 * Hear every batch of journal rows the fan-out reads from now on, whoever
 * committed them on whichever instance. Server-side only: the rows never
 * leave the process (a tab hears only the `draft` topic).
 *
 * @returns the unsubscribe function
 */
export function subscribeEntityChanges(listener: EntityChangeListener): () => void {
  entityListeners.add(listener);
  return () => {
    entityListeners.delete(listener);
  };
}

/** The NOTIFY payload of a committing operation's topics: `<instance>|<topic,...>`. */
export function liveTopicsPayload(instanceId: string, topics: readonly LiveTopic[]): string {
  return `${instanceId}|${topics.join(",")}`;
}

/**
 * Parse a {@link liveTopicsPayload}. Malformed payloads and unknown topics
 * are refused loudly (null + a log line), never half-applied.
 */
export function parseLiveTopicsPayload(
  payload: string,
): { instanceId: string; topics: LiveTopic[] } | null {
  const bar = payload.lastIndexOf("|");
  if (bar <= 0) return null;
  const names = payload.slice(bar + 1).split(",");
  if (!names.every(isLiveTopic)) return null;
  return { instanceId: payload.slice(0, bar), topics: names as LiveTopic[] };
}

/** Every journal kind: any committed change to a journaled row is a draft change. */
const DRAFT_FILTER = { kinds: [...JOURNAL_KINDS] } as const;
/** Rows read per journal statement of one wake-up. */
const DRAFT_PAGE = 1000;
/** How long a wake-up waits for the rest of its burst before it reads. */
const WAKE_COALESCE_MS = 25;

/** Options of {@link startLiveFanOut}. */
export interface LiveFanOutOptions {
  readonly adapter: DatabaseAdapter;
  /** This process's id; its own notices are skipped (it published them already). */
  readonly instanceId: string;
}

/** A running fan-out; `stop` unlistens and removes the commit notice. */
export interface LiveFanOut {
  stop(): Promise<void>;
  /** Wait until every wake-up received so far has been read (tests). */
  settled(): Promise<void>;
}

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-000000000000",
  actorKind: "system" as const,
  requestId: "live-fan-out",
};

/**
 * Issue #1267 — deliver live topics across admin instances.
 *
 * - Each committing operation with topics NOTIFYs them inside its own
 *   transaction (`setCommitNotice`): delivered on commit, never on rollback.
 * - Each instance LISTENs and publishes another instance's topics locally.
 * - The journal's wake-up makes each instance read the journal from its
 *   in-memory cursor and publish `draft` when rows arrived. After a
 *   reconnect the read catches up from the cursor; a cursor below the GC
 *   horizon publishes `draft` once and restarts at "now" (the surfaces
 *   re-read, which is the rebuild of a live view).
 *
 * @example
 *   const fanOut = await startLiveFanOut({ adapter, instanceId: hostInstanceId() });
 *   // …on shutdown:
 *   await fanOut.stop();
 */
export async function startLiveFanOut(opts: LiveFanOutOptions): Promise<LiveFanOut> {
  const { adapter, instanceId } = opts;
  ensureObserving();
  setCommitNotice((name) => {
    const topics = liveTopicsOfOperation(name);
    return topics.length === 0
      ? null
      : { channel: LIVE_TOPICS_CHANNEL, payload: liveTopicsPayload(instanceId, topics) };
  });

  let cursor: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function readOnce(): Promise<void> {
    const changes: JournalChange[] = [];
    await adapter.withAdminTransaction(
      SYSTEM_CTX,
      async (tx) => {
        if (cursor === null) {
          cursor = await currentJournalCursor(tx);
          return;
        }
        let target: string | null = null;
        let after: [string, string, string] | null = null;
        for (;;) {
          const page = await readChanges(tx, {
            cursor,
            target,
            after,
            filter: DRAFT_FILTER,
            limit: DRAFT_PAGE,
          });
          if (page.needsRebuild) {
            cursor = await currentJournalCursor(tx);
            publishLiveTopics(["draft"]);
            return;
          }
          changes.push(...page.changes);
          if (!page.more) {
            cursor = page.target;
            return;
          }
          target = page.target;
          const last = page.changes.at(-1);
          after = last ? [last.xid, last.table, last.rowId] : after;
        }
      },
      { holder: "live-fan-out" },
    );
    if (changes.length === 0) return;
    publishLiveTopics(["draft"]);
    for (const listener of entityListeners) {
      try {
        listener(changes);
      } catch (thrown) {
        console.error("[live-events] entity-change listener failed", thrown);
      }
    }
  }

  /** Read the journal now; wake-ups during a read run one more read after it. */
  function wake(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        // One read per burst: the commits of one agent turn arrive within
        // milliseconds of each other.
        await new Promise((resolve) => setTimeout(resolve, WAKE_COALESCE_MS));
        do {
          again = false;
          await readOnce();
        } while (again);
      } catch (thrown) {
        // Loud, and the next wake-up retries from the same cursor: no
        // change is lost, only delivered later.
        console.error("[live-events] reading the change journal failed", thrown);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  let topicsListened = false;
  const handles: ListenHandle[] = [];
  handles.push(
    await adapter.listen("admin", LIVE_TOPICS_CHANNEL, {
      onNotify: (payload) => {
        const parsed = parseLiveTopicsPayload(payload);
        if (parsed === null) {
          console.error(
            `[live-events] ignoring a malformed live-topics notice: ${payload.slice(0, 120)}`,
          );
          return;
        }
        if (parsed.instanceId !== instanceId) publishLiveTopics(parsed.topics);
      },
      onListen: () => {
        // A reconnect may have missed notices: every surface re-reads once.
        if (topicsListened) publishLiveTopics([...LIVE_TOPICS]);
        topicsListened = true;
      },
      // Other instances' topics of the gap arrive nowhere; the re-read on
      // the reconnect above covers them. Nothing here is cached.
      onLost: (cause) =>
        console.warn("[live-events] the live-topics LISTEN connection dropped", cause),
    }),
  );
  handles.push(
    // The journal cursor is the truth: a reconnect reads on from it, so the
    // gap's changes are caught up, never lost.
    await adapter.listen("admin", JOURNAL_CHANNEL, {
      onNotify: () => void wake(),
      onListen: () => void wake(),
      onLost: (cause) =>
        console.warn("[live-events] the change-journal LISTEN connection dropped", cause),
    }),
  );
  await wake();

  return {
    async stop() {
      setCommitNotice(null);
      await Promise.all(handles.map((h) => h.unlisten()));
      await running;
    },
    async settled() {
      while (running) await running;
    },
  };
}
