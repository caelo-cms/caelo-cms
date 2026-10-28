// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — how an editor tab stays current without polling the admin
 * on a timer (CLAUDE.md §11.B: every request keeps an instance up; on
 * 2026-10-28 two idle tabs made ~1.7 requests a second and stacked >100
 * in-flight requests when the admin slowed down).
 *
 * Each live surface (the running-agents bar, the pending strip, the quality
 * status, …) registers a {@link LiveConsumer}: the topics it shows and how
 * to re-read itself. It is re-read when
 * - a topic it shows arrives: from this tab's chat stream while a turn runs
 *   (`{kind: "live"}` events), or from the wait below;
 * - the tab becomes visible or the window gets focus;
 * - this tab did something itself (`publish` after an Approve, a Stop …).
 *
 * While a consumer WAITS on work in progress that no stream of this tab
 * reports (an audit running, an external agent working, a crawl, a deploy)
 * and the tab is visible, the hub holds one request to `/api/live-events`,
 * which the server answers with the first matching topic or after 10 s.
 * After an empty answer the waiting consumers re-read themselves once, since
 * a change committed on another admin instance announces nothing here. An
 * idle tab — nothing waiting, no turn — makes no request at all.
 *
 * Every request the hub makes has a deadline (`AbortSignal.timeout`), there
 * is never more than one wait on the wire, and a failed wait is not retried
 * on a timer: the next focus, visibility change or own action resumes it.
 */

import type { LiveTopic } from "@caelo-cms/shared";

/** Deadline of a live surface's own read (pending, agents, quality …). */
export const LIVE_READ_TIMEOUT_MS = 15_000;
/** Deadline of one `/api/live-events` wait; the server answers within 10 s. */
export const LIVE_WAIT_TIMEOUT_MS = 20_000;
/** Visibility and focus fire together; one re-read covers both. */
const FOCUS_DEDUPE_MS = 1_000;

/** Why a consumer is asked to re-read. */
export type LiveRefreshReason = "topic" | "focus" | "wait-expired";

/** One live surface of the editor. */
export interface LiveConsumer {
  /** The topics this surface shows. */
  readonly topics: readonly LiveTopic[];
  /** Re-read now. Must carry its own in-flight guard (see `coalescedRefresh`). */
  readonly refresh: (reason: LiveRefreshReason) => void;
  /**
   * True while the surface waits on work in progress that may change it
   * without any action of this tab (an audit running, an external agent).
   * Omitted = never waits; the surface is re-read on topics and focus only.
   */
  readonly waiting?: () => boolean;
}

/** What the hub needs from the browser (injectable for tests). */
export interface LiveHubEnv {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly isVisible: () => boolean;
  /** Subscribe to "the tab became visible / the window got focus". */
  readonly onFocus: (listener: () => void) => () => void;
}

/** The per-tab hub. */
export interface LiveHub {
  /** Add a surface. @returns its removal. */
  register(consumer: LiveConsumer): () => void;
  /** Topics changed: re-read every surface that shows one of them. */
  publish(topics: readonly LiveTopic[]): void;
  /** A surface's `waiting()` may have changed: start the wait if it is needed now. */
  kick(): void;
  /** This tab's chat stream is open (its `live` events stand in for the wait). @returns the close. */
  openStream(): () => void;
}

/**
 * Fetch with the live surfaces' deadline. Use it for every live read so a
 * slow admin never stacks requests from one tab.
 */
export function liveFetch(
  url: string,
  init: RequestInit = {},
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  return fetchFn(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(LIVE_READ_TIMEOUT_MS),
  });
}

/** Build a hub over `env`. The app uses {@link liveHub}; tests build their own. */
export function createLiveHub(env: LiveHubEnv): LiveHub {
  const consumers = new Set<LiveConsumer>();
  let openStreams = 0;
  let waitRunning = false;
  // Set by a failed wait; only a focus, visibility change or own action
  // clears it, so a broken endpoint is never hammered by a loop.
  let suspended = false;
  let lastFocusAt = Number.NEGATIVE_INFINITY;
  let stopFocus: (() => void) | null = null;

  const waitingConsumers = () => [...consumers].filter((c) => c.waiting?.() === true);

  const allTopics = (): LiveTopic[] => {
    const set = new Set<LiveTopic>();
    for (const c of consumers) for (const t of c.topics) set.add(t);
    return [...set].sort();
  };

  const publish = (topics: readonly LiveTopic[]) => {
    if (topics.length === 0) return;
    const wanted = new Set(topics);
    for (const c of [...consumers]) {
      if (c.topics.some((t) => wanted.has(t))) c.refresh("topic");
    }
  };

  const shouldWait = () =>
    !suspended && openStreams === 0 && env.isVisible() && waitingConsumers().length > 0;

  async function runWait(): Promise<void> {
    if (waitRunning) return;
    waitRunning = true;
    try {
      while (shouldWait()) {
        const topics = allTopics();
        let answered: LiveTopic[];
        try {
          const res = await env.fetch(`/api/live-events?topics=${topics.join(",")}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(LIVE_WAIT_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          answered = ((await res.json()) as { topics: LiveTopic[] }).topics;
        } catch {
          suspended = true;
          return;
        }
        if (answered.length > 0) publish(answered);
        else for (const c of waitingConsumers()) c.refresh("wait-expired");
      }
    } finally {
      waitRunning = false;
    }
  }

  const kick = () => {
    if (shouldWait()) void runWait();
  };

  const onFocus = () => {
    if (!env.isVisible()) return;
    const now = env.now();
    if (now - lastFocusAt < FOCUS_DEDUPE_MS) return;
    lastFocusAt = now;
    suspended = false;
    for (const c of [...consumers]) c.refresh("focus");
    kick();
  };

  return {
    register(consumer) {
      consumers.add(consumer);
      stopFocus ??= env.onFocus(onFocus);
      // Deferred: `register` runs inside Svelte effects, and reading every
      // consumer's `waiting()` there would make that effect depend on other
      // components' state (and re-register, and re-read, on each change).
      queueMicrotask(kick);
      return () => {
        consumers.delete(consumer);
        if (consumers.size === 0 && stopFocus) {
          stopFocus();
          stopFocus = null;
        }
      };
    },
    publish(topics) {
      suspended = false;
      publish(topics);
      kick();
    },
    kick,
    openStream() {
      openStreams += 1;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        openStreams -= 1;
        queueMicrotask(kick);
      };
    },
  };
}

const browserEnv: LiveHubEnv = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  onFocus(listener) {
    if (typeof window === "undefined") return () => undefined;
    const onVisibility = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", listener);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", listener);
    };
  },
};

/** The tab's hub. */
export const liveHub: LiveHub = createLiveHub(browserEnv);
