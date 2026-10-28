// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the editor's live-refresh hub: an idle tab makes no request,
 * a tab waiting on work in progress holds exactly one bounded wait, and a
 * failed wait is not retried on a timer.
 */

import { describe, expect, it } from "bun:test";
import type { LiveTopic } from "@caelo-cms/shared";
import {
  createLiveHub,
  type LiveHubEnv,
  type LiveRefreshReason,
  LIVE_READ_TIMEOUT_MS,
  liveFetch,
} from "./live-refresh.js";

interface Pending {
  readonly url: string;
  readonly signal: AbortSignal | null | undefined;
  readonly answer: (topics: LiveTopic[] | "fail") => void;
}

function fakeEnv() {
  const requests: Pending[] = [];
  let visible = true;
  let now = 0;
  let focusListener: (() => void) | null = null;
  const env: LiveHubEnv = {
    fetch: (url, init) =>
      new Promise<Response>((resolve) => {
        requests.push({
          url,
          signal: init.signal,
          answer: (topics) =>
            resolve(
              topics === "fail"
                ? new Response("down", { status: 503 })
                : Response.json({ topics }),
            ),
        });
      }),
    now: () => now,
    isVisible: () => visible,
    onFocus: (listener) => {
      focusListener = listener;
      return () => {
        focusListener = null;
      };
    },
  };
  return {
    env,
    requests,
    setVisible: (v: boolean) => {
      visible = v;
    },
    advance: (ms: number) => {
      now += ms;
    },
    focus: () => focusListener?.(),
    hasFocusListener: () => focusListener !== null,
  };
}

/** Let queued microtasks and resolved fetches run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function consumer(topics: LiveTopic[], waiting?: () => boolean) {
  const calls: LiveRefreshReason[] = [];
  return {
    calls,
    consumer: {
      topics,
      refresh: (reason: LiveRefreshReason) => void calls.push(reason),
      ...(waiting ? { waiting } : {}),
    },
  };
}

describe("live-refresh hub", () => {
  it("an idle tab makes no request: nothing waits, no turn runs", async () => {
    const f = fakeEnv();
    const hub = createLiveHub(f.env);
    const bell = consumer(["pending", "deploys"]);
    const bar = consumer(["agents"], () => false);
    hub.register(bell.consumer);
    hub.register(bar.consumer);
    await settle();
    hub.kick();
    await settle();
    expect(f.requests).toEqual([]);
    // Own action / stream topic: re-read the matching surface only, still no wait.
    hub.publish(["pending"]);
    await settle();
    expect(bell.calls).toEqual(["topic"]);
    expect(bar.calls).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("holds one wait while a surface waits, and re-reads on the topics it answers", async () => {
    const f = fakeEnv();
    const hub = createLiveHub(f.env);
    let busy = true;
    const quality = consumer(["quality"], () => busy);
    const bell = consumer(["pending"]);
    hub.register(quality.consumer);
    hub.register(bell.consumer);
    await settle();
    expect(f.requests).toHaveLength(1);
    // The wait asks for every registered surface's topics, with a deadline.
    expect(f.requests[0]?.url).toBe("/api/live-events?topics=pending,quality");
    expect(f.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    hub.kick();
    await settle();
    expect(f.requests).toHaveLength(1);

    f.requests[0]?.answer(["pending"]);
    await settle();
    expect(bell.calls).toEqual(["topic"]);
    expect(quality.calls).toEqual([]);
    expect(f.requests).toHaveLength(2);

    // An empty answer (another instance may have committed): the waiting
    // surface re-reads itself once.
    f.requests[1]?.answer([]);
    await settle();
    expect(quality.calls).toEqual(["wait-expired"]);
    expect(bell.calls).toEqual(["topic"]);

    busy = false;
    f.requests[2]?.answer(["quality"]);
    await settle();
    expect(quality.calls).toEqual(["wait-expired", "topic"]);
    expect(f.requests).toHaveLength(3);
  });

  it("does not wait while the tab is hidden; becoming visible re-reads and resumes", async () => {
    const f = fakeEnv();
    const hub = createLiveHub(f.env);
    f.setVisible(false);
    const bar = consumer(["agents"], () => true);
    hub.register(bar.consumer);
    await settle();
    expect(f.requests).toEqual([]);
    f.focus();
    expect(bar.calls).toEqual([]);
    f.setVisible(true);
    f.focus();
    await settle();
    expect(bar.calls).toEqual(["focus"]);
    expect(f.requests).toHaveLength(1);
  });

  it("an open chat stream stands in for the wait", async () => {
    const f = fakeEnv();
    const hub = createLiveHub(f.env);
    const close = hub.openStream();
    hub.register(consumer(["agents"], () => true).consumer);
    await settle();
    expect(f.requests).toEqual([]);
    close();
    close();
    await settle();
    expect(f.requests).toHaveLength(1);
  });

  it("a failed wait is not retried on a timer; focus resumes it", async () => {
    const f = fakeEnv();
    const hub = createLiveHub(f.env);
    const bar = consumer(["agents"], () => true);
    hub.register(bar.consumer);
    await settle();
    f.requests[0]?.answer("fail");
    await settle();
    hub.kick();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.requests).toHaveLength(1);
    f.focus();
    await settle();
    expect(bar.calls).toEqual(["focus"]);
    expect(f.requests).toHaveLength(2);
  });

  it("visibility and focus firing together re-read once", async () => {
    const f = fakeEnv();
    const hub = createLiveHub(f.env);
    const bell = consumer(["pending"]);
    const stop = hub.register(bell.consumer);
    f.focus();
    f.focus();
    expect(bell.calls).toEqual(["focus"]);
    f.advance(1_500);
    f.focus();
    expect(bell.calls).toEqual(["focus", "focus"]);
    stop();
    expect(f.hasFocusListener()).toBe(false);
  });
});

describe("liveFetch", () => {
  it("gives every live read a deadline unless the caller brings its own signal", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchFn = async (_url: string, init: RequestInit) => {
      seen.push(init.signal);
      return new Response("{}");
    };
    await liveFetch("/x", {}, fetchFn);
    const own = new AbortController().signal;
    await liveFetch("/x", { signal: own }, fetchFn);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]).not.toBe(own);
    expect(seen[1]).toBe(own);
    expect(LIVE_READ_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
