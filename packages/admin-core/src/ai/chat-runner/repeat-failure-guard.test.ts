// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the repeated-identical-failure breaker. The breaker must trip
 * on an EXACT (tool + args + error) repeat and stay silent otherwise, so it can
 * stop a single bad-arg pattern from burning the whole tool-loop cap without
 * ever interfering with a model that is actually making progress.
 */

import { describe, expect, it } from "bun:test";
import {
  blockedCallResult,
  callIdentity,
  REPEAT_FAILURE_THRESHOLD,
  RepeatedFailureTracker,
  repeatedFailureNudge,
  stableStringify,
} from "./repeat-failure-guard.js";

const CHILDREN_ERROR =
  "invalid arguments for add_module_to_layout:\n- Unrecognized argument(s): `children`";

describe("stableStringify", () => {
  it("is key-order-independent for objects", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("preserves array order (order is semantically meaningful)", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("distinguishes different values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe("callIdentity", () => {
  it("collapses same tool + structurally-equal args regardless of key order", () => {
    expect(callIdentity("t", { a: 1, b: 2 })).toBe(callIdentity("t", { b: 2, a: 1 }));
  });

  it("separates different tools with identical args", () => {
    expect(callIdentity("t1", { a: 1 })).not.toBe(callIdentity("t2", { a: 1 }));
  });
});

describe("RepeatedFailureTracker", () => {
  const failure = (content = CHILDREN_ERROR) => ({
    name: "add_module_to_layout",
    arguments: { layoutSlug: "site-default", blockName: "header", children: [{ label: "Home" }] },
    content,
  });

  it("does NOT trip on the first identical failure (one-shot mistakes self-correct)", () => {
    const t = new RepeatedFailureTracker();
    const r = t.record(failure());
    expect(r.count).toBe(1);
    expect(r.tripped).toBe(false);
    expect(r.blocked).toBe(false);
    expect(t.isBlocked(failure().name, failure().arguments)).toBe(false);
  });

  it("trips on the SECOND identical (tool + args + error) failure", () => {
    const t = new RepeatedFailureTracker();
    t.record(failure());
    const r = t.record(failure());
    expect(r.count).toBe(REPEAT_FAILURE_THRESHOLD);
    expect(r.tripped).toBe(true);
    expect(r.blocked).toBe(true);
    expect(t.isBlocked(failure().name, failure().arguments)).toBe(true);
  });

  it("trips regardless of argument key order (uses stable identity)", () => {
    const t = new RepeatedFailureTracker();
    t.record({
      name: "x",
      arguments: { a: 1, b: 2 },
      content: "boom",
    });
    const r = t.record({
      name: "x",
      arguments: { b: 2, a: 1 },
      content: "boom",
    });
    expect(r.tripped).toBe(true);
  });

  it("`tripped` fires only once, on the crossing record (nudge injected once)", () => {
    const t = new RepeatedFailureTracker();
    const results = [t.record(failure()), t.record(failure()), t.record(failure())];
    expect(results.map((r) => r.tripped)).toEqual([false, true, false]);
    // …but it stays blocked after the crossing.
    expect(results.map((r) => r.blocked)).toEqual([false, true, true]);
  });

  it("does NOT trip when the SAME call fails with a DIFFERENT error (progress)", () => {
    const t = new RepeatedFailureTracker();
    t.record(failure("error A"));
    const r = t.record(failure("error B"));
    expect(r.tripped).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it("does NOT trip when the error repeats but the ARGS differ (progress)", () => {
    const t = new RepeatedFailureTracker();
    t.record({ name: "t", arguments: { field: "a" }, content: "same error" });
    const r = t.record({ name: "t", arguments: { field: "b" }, content: "same error" });
    expect(r.tripped).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it("tracks distinct failing patterns independently", () => {
    const t = new RepeatedFailureTracker();
    // Pattern 1 fails twice → trips.
    t.record({ name: "t", arguments: { a: 1 }, content: "e1" });
    const p1 = t.record({ name: "t", arguments: { a: 1 }, content: "e1" });
    // Pattern 2 fails once → does not trip.
    const p2 = t.record({ name: "t", arguments: { a: 2 }, content: "e2" });
    expect(p1.tripped).toBe(true);
    expect(p2.tripped).toBe(false);
    expect(t.isBlocked("t", { a: 1 })).toBe(true);
    expect(t.isBlocked("t", { a: 2 })).toBe(false);
  });

  it("a successful/other call between two identical failures does not reset the count", () => {
    const t = new RepeatedFailureTracker();
    t.record(failure());
    // an unrelated failure in between
    t.record({ name: "other", arguments: {}, content: "x" });
    const r = t.record(failure());
    expect(r.tripped).toBe(true);
  });
});

describe("breaker message helpers", () => {
  it("nudge names the tool + count and forbids repeating", () => {
    const msg = repeatedFailureNudge("add_module_to_layout", 2);
    expect(msg).toContain("add_module_to_layout");
    expect(msg).toContain("2 times");
    expect(msg.toLowerCase()).toContain("do not repeat");
    expect(msg.toLowerCase()).toContain("change your approach");
  });

  it("blocked result explains the call was not re-run", () => {
    const msg = blockedCallResult("add_module_to_layout");
    expect(msg).toContain("add_module_to_layout");
    expect(msg.toLowerCase()).toContain("not re-run");
  });
});
