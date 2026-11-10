// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — whether someone is at the tab: visible and used within
 * OPERATOR_IDLE_MS, and "back" the moment that changes, without a timer.
 */

import { describe, expect, it } from "bun:test";
import {
  createPresence,
  FRAME_INPUT_INTERVAL_MS,
  isPresent,
  OPERATOR_IDLE_MS,
  type PresenceDom,
} from "./presence.js";

function fakeDom() {
  let now = 0;
  let visible = true;
  const listeners = new Map<string, () => void>();
  const dom: PresenceDom = {
    now: () => now,
    visible: () => visible,
    listen: (target, type, listener) => void listeners.set(`${target}:${type}`, listener),
  };
  return {
    dom,
    listeners,
    advance: (ms: number) => {
      now += ms;
    },
    fire: (key: string) => listeners.get(key)?.(),
    setVisible: (v: boolean) => {
      visible = v;
    },
  };
}

describe("#1361 — operator presence", () => {
  it("counts a visible tab used within the idle window as present", () => {
    const f = fakeDom();
    const presence = createPresence(f.dom);
    expect(isPresent(presence)).toBe(true);
    f.advance(OPERATOR_IDLE_MS - 1);
    expect(isPresent(presence)).toBe(true);
    f.advance(1);
    expect(isPresent(presence)).toBe(false);
    f.setVisible(false);
    f.advance(-OPERATOR_IDLE_MS);
    expect(isPresent(presence)).toBe(false);
  });

  it("announces the return on the first input after an idle stretch only", () => {
    const f = fakeDom();
    const presence = createPresence(f.dom);
    let returns = 0;
    presence.onReturn(() => {
      returns += 1;
    });
    f.advance(1_000);
    f.fire("window:pointermove");
    expect(returns).toBe(0);
    f.advance(OPERATOR_IDLE_MS);
    f.fire("window:keydown");
    expect(returns).toBe(1);
    expect(presence.idleMs()).toBe(0);
    f.fire("window:pointermove");
    expect(returns).toBe(1);
  });

  it("counts input the preview frame reports like input here (Codex review of #1557)", () => {
    // Input inside the editor's sandboxed preview never reaches this
    // window's listeners: an operator editing in the preview for ten
    // minutes would read as gone, and the live waits would stop.
    const f = fakeDom();
    const presence = createPresence(f.dom);
    let returns = 0;
    presence.onReturn(() => {
      returns += 1;
    });
    for (let minute = 0; minute < 15; minute += 1) {
      f.advance(FRAME_INPUT_INTERVAL_MS);
      presence.noteInput();
    }
    expect(isPresent(presence)).toBe(true);
    expect(returns).toBe(0);
    // The first reported input after an idle stretch is a return.
    f.advance(OPERATOR_IDLE_MS);
    expect(isPresent(presence)).toBe(false);
    presence.noteInput();
    expect(returns).toBe(1);
    expect(isPresent(presence)).toBe(true);
  });

  it("announces showing and focus as a return, hiding as a hide", () => {
    const f = fakeDom();
    const presence = createPresence(f.dom);
    const events: string[] = [];
    presence.onReturn(() => void events.push("return"));
    const stopHide = presence.onHide(() => void events.push("hide"));
    f.setVisible(false);
    f.fire("document:visibilitychange");
    f.setVisible(true);
    f.advance(5_000);
    f.fire("document:visibilitychange");
    expect(presence.idleMs()).toBe(0);
    f.fire("window:focus");
    expect(events).toEqual(["hide", "return", "return"]);
    stopHide();
    f.setVisible(false);
    f.fire("document:visibilitychange");
    expect(events).toEqual(["hide", "return", "return"]);
  });

  it("listens to nothing until someone subscribes", () => {
    const f = fakeDom();
    const presence = createPresence(f.dom);
    expect(f.listeners.size).toBe(0);
    presence.onReturn(() => undefined);
    presence.onHide(() => undefined);
    expect([...f.listeners.keys()].sort()).toEqual([
      "document:visibilitychange",
      "window:focus",
      "window:keydown",
      "window:pointerdown",
      "window:pointermove",
      "window:touchstart",
      "window:wheel",
    ]);
  });
});
