// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — whether someone is at this tab: what bounds the requests a
 * tab holds open while nobody works.
 *
 * The admin runs on request-billed CPU (CLAUDE.md §11.B): an instance is
 * billed for as long as any request is open on it, so a request a tab
 * holds open for nobody — the live-events wait of a surface that waits on
 * long work, the gateway live view's stream — would bill the admin around
 * the clock for a tab left open. A tab is present while it is visible and
 * the operator used it (pointer, keyboard, touch, wheel, focus) within the
 * last {@link OPERATOR_IDLE_MS}. Those surfaces hold a request only while
 * the tab is present, and resume the moment the operator is back: the tab
 * becomes visible, the window gets focus, or the first input after an idle
 * stretch.
 *
 * Nothing here runs on a timer: input events keep the clock, and a surface
 * asks {@link Presence.idleMs} whenever it is about to hold a request again.
 */

/** How long a visible tab nobody uses still counts as attended. */
export const OPERATOR_IDLE_MS = 10 * 60 * 1000;

/** Whether, and since when, someone is at this tab. */
export interface Presence {
  /** The tab is visible. */
  isVisible(): boolean;
  /** Milliseconds since the operator last used this tab (or it became visible). */
  idleMs(): number;
  /**
   * "The operator is back": the tab became visible, the window got focus,
   * or the first input after at least {@link OPERATOR_IDLE_MS} without any.
   *
   * @returns the unsubscribe
   */
  onReturn(listener: () => void): () => void;
  /** The tab was hidden. @returns the unsubscribe */
  onHide(listener: () => void): () => void;
}

/** Whether `presence` says someone is at the tab now. */
export function isPresent(presence: Presence): boolean {
  return presence.isVisible() && presence.idleMs() < OPERATOR_IDLE_MS;
}

/** Input that says the operator uses the tab. Passive and captured: it is only counted. */
export const PRESENCE_INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** The browser parts presence listens to (injectable for tests). */
export interface PresenceDom {
  readonly now: () => number;
  readonly visible: () => boolean;
  /** Listen on the window (input, focus) or the document (visibility); called once. */
  readonly listen: (target: "window" | "document", type: string, listener: () => void) => void;
}

/** Presence over `dom`; it starts listening with the first subscription. */
export function createPresence(dom: PresenceDom): Presence {
  let lastUsedAt = dom.now();
  const returns = new Set<() => void>();
  const hides = new Set<() => void>();
  let attached = false;
  const announce = (listeners: Set<() => void>) => {
    for (const listener of [...listeners]) listener();
  };
  const used = (): number => {
    const now = dom.now();
    const idleFor = now - lastUsedAt;
    lastUsedAt = now;
    return idleFor;
  };
  const attach = () => {
    if (attached) return;
    attached = true;
    for (const type of PRESENCE_INPUT_EVENTS) {
      dom.listen("window", type, () => {
        if (used() >= OPERATOR_IDLE_MS) announce(returns);
      });
    }
    dom.listen("document", "visibilitychange", () => {
      if (!dom.visible()) {
        announce(hides);
        return;
      }
      used();
      announce(returns);
    });
    dom.listen("window", "focus", () => {
      used();
      announce(returns);
    });
  };
  return {
    isVisible: dom.visible,
    idleMs: () => dom.now() - lastUsedAt,
    onReturn(listener) {
      attach();
      returns.add(listener);
      return () => void returns.delete(listener);
    },
    onHide(listener) {
      attach();
      hides.add(listener);
      return () => void hides.delete(listener);
    },
  };
}

const browserDom: PresenceDom = {
  now: () => Date.now(),
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  listen(target, type, listener) {
    if (typeof window === "undefined") return;
    const on = target === "window" ? window : document;
    // Input is counted wherever it lands (captured, passive). Focus is the
    // window's own: captured, every field's focus would count as a return.
    const input = (PRESENCE_INPUT_EVENTS as readonly string[]).includes(type);
    on.addEventListener(type, listener, input ? { capture: true, passive: true } : undefined);
  },
};

/** This tab's presence. */
export const browserPresence: Presence = createPresence(browserDom);
