// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — an EventSource that is open only while someone is at the
 * tab (presence.ts).
 *
 * The admin runs on request-billed CPU: an open stream bills an instance
 * for as long as it is open, so a live view left open in a forgotten tab
 * would bill the admin around the clock. The server ends each stream after
 * a bounded lifetime with an `end` event; this controller then reopens it
 * at once while the tab is present, and otherwise only when the operator is
 * back (the tab becomes visible, the window gets focus, the first input
 * after an idle stretch). Hiding the tab closes the stream at once. After a
 * connection error the browser's own reconnect runs only for a present tab.
 *
 * Nothing here runs on a timer (scripts/no-timer-polling.test.ts): every
 * open follows an event — mounting, the server's `end`, the operator's
 * return.
 */

import { browserPresence, isPresent, type Presence } from "./presence.js";

/** EventSource's `readyState` once the browser gave up on the stream. */
const CLOSED = 2;

/**
 * Where the stream stands: `live` (open), `connecting` (opening or
 * reconnecting), `paused` (closed because nobody is at the tab; the
 * operator's return reopens it), `disconnected` (the browser gave up; the
 * operator's return tries again).
 */
export type PresentStreamState = "live" | "connecting" | "paused" | "disconnected";

/** The parts of an EventSource the controller uses (injectable for tests). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: "end", listener: () => void): void;
  close(): void;
}

/** What the page hears from the stream. */
export interface PresentStreamHandlers {
  /** One `data:` frame. */
  onMessage(data: string): void;
  onState(state: PresentStreamState): void;
}

/** What the controller needs from the browser (injectable for tests). */
export interface PresentStreamEnv {
  readonly presence: Presence;
  readonly open: (url: string) => EventSourceLike;
}

const browserStreamEnv: PresentStreamEnv = {
  presence: browserPresence,
  open: (url) => new EventSource(url),
};

/**
 * Hold the event stream at `url` while someone is at the tab.
 *
 * @returns the stop: closes the stream and forgets the tab's events
 */
export function openWhilePresent(
  url: string,
  handlers: PresentStreamHandlers,
  env: PresentStreamEnv = browserStreamEnv,
): () => void {
  let source: EventSourceLike | null = null;
  let stopped = false;
  const close = (state: "paused" | "disconnected"): void => {
    if (!source) return;
    source.close();
    source = null;
    if (!stopped) handlers.onState(state);
  };
  const open = (): void => {
    if (stopped || source) return;
    if (!isPresent(env.presence)) {
      handlers.onState("paused");
      return;
    }
    const s = env.open(url);
    source = s;
    handlers.onState("connecting");
    s.onopen = () => {
      if (source === s) handlers.onState("live");
    };
    s.onmessage = (ev) => {
      if (source === s) handlers.onMessage(String(ev.data));
    };
    // The server's bounded lifetime ran out: reopen while someone is here.
    s.addEventListener("end", () => {
      if (source !== s) return;
      close("paused");
      open();
    });
    s.onerror = () => {
      if (source !== s) return;
      // EventSource reconnects on its own; let it only for a present tab.
      if (s.readyState === CLOSED) close("disconnected");
      else if (!isPresent(env.presence)) close("paused");
      else handlers.onState("connecting");
    };
  };
  const stopReturn = env.presence.onReturn(open);
  const stopHide = env.presence.onHide(() => close("paused"));
  open();
  return () => {
    stopped = true;
    stopReturn();
    stopHide();
    close("paused");
  };
}
