// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — the gateway live view's stream is open only while someone
 * is at the tab: an open stream bills the request-billed admin for as long
 * as it is open, so a forgotten tab must not hold one.
 */

import { describe, expect, it } from "bun:test";
import { type EventSourceLike, openWhilePresent, type PresentStreamState } from "./live-stream.js";
import { OPERATOR_IDLE_MS, type Presence } from "./presence.js";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  private end: (() => void) | null = null;
  addEventListener(_type: "end", listener: () => void): void {
    this.end = listener;
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  fireMessage(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  fireEnd(): void {
    this.end?.();
  }
  fireError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

function fakeTab() {
  let visible = true;
  let idle = 0;
  const returns = new Set<() => void>();
  const hides = new Set<() => void>();
  const presence: Presence = {
    isVisible: () => visible,
    idleMs: () => idle,
    onReturn: (l) => {
      returns.add(l);
      return () => void returns.delete(l);
    },
    onHide: (l) => {
      hides.add(l);
      return () => void hides.delete(l);
    },
    noteInput: () => {
      idle = 0;
    },
  };
  const sources: FakeSource[] = [];
  const states: PresentStreamState[] = [];
  const frames: string[] = [];
  const stop = openWhilePresent(
    "/settings/gateway/live",
    { onMessage: (d) => void frames.push(d), onState: (s) => void states.push(s) },
    {
      presence,
      open: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    },
  );
  return {
    sources,
    states,
    frames,
    stop,
    open: () => sources.filter((s) => !s.closed),
    hide: () => {
      visible = false;
      for (const l of [...hides]) l();
    },
    show: () => {
      visible = true;
      idle = 0;
      for (const l of [...returns]) l();
    },
    walkAway: () => {
      idle = OPERATOR_IDLE_MS;
    },
    comeBack: () => {
      idle = 0;
      for (const l of [...returns]) l();
    },
  };
}

describe("#1361 — a live stream only while someone is at the tab", () => {
  it("opens while someone is there, and the server's end reopens it at once", () => {
    const t = fakeTab();
    expect(t.open()).toHaveLength(1);
    t.sources[0]?.fireOpen();
    t.sources[0]?.fireMessage('{"n":1}');
    expect(t.frames).toEqual(['{"n":1}']);
    expect(t.states.at(-1)).toBe("live");
    t.sources[0]?.fireEnd();
    expect(t.sources[0]?.closed).toBe(true);
    expect(t.open()).toHaveLength(1);
    expect(t.sources).toHaveLength(2);
  });

  it("closes at once when the tab is hidden, and reopens when it is shown", () => {
    const t = fakeTab();
    t.hide();
    expect(t.open()).toHaveLength(0);
    expect(t.states.at(-1)).toBe("paused");
    t.show();
    expect(t.open()).toHaveLength(1);
  });

  it("a stream nobody watches stays closed at its end until the operator is back", () => {
    const t = fakeTab();
    t.walkAway();
    t.sources[0]?.fireEnd();
    expect(t.open()).toHaveLength(0);
    expect(t.states.at(-1)).toBe("paused");
    t.comeBack();
    expect(t.open()).toHaveLength(1);
  });

  it("after an error the browser reconnects only for a present tab; a stream it gave up waits for the return", () => {
    const t = fakeTab();
    t.sources[0]?.fireError(0);
    expect(t.open()).toHaveLength(1);
    expect(t.states.at(-1)).toBe("connecting");
    t.walkAway();
    t.sources[0]?.fireError(0);
    expect(t.open()).toHaveLength(0);
    t.comeBack();
    expect(t.open()).toHaveLength(1);
    t.sources[1]?.fireError(2);
    expect(t.open()).toHaveLength(0);
    expect(t.states.at(-1)).toBe("disconnected");
    t.comeBack();
    expect(t.open()).toHaveLength(1);
  });

  it("stopping closes the stream and ignores the tab's later events", () => {
    const t = fakeTab();
    t.stop();
    expect(t.open()).toHaveLength(0);
    t.comeBack();
    t.show();
    expect(t.open()).toHaveLength(0);
  });
});
