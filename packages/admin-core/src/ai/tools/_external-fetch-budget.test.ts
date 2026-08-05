// SPDX-License-Identifier: MPL-2.0

/**
 * issue #423 — the live-inspect fetch budget must be configurable and its
 * denial AI-actionable: limit, reset window, and the env knob all named
 * (CLAUDE.md §11 failure surfaces). A malformed knob fails loudly instead
 * of silently reverting to the default (CLAUDE.md §2 no-fallbacks).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  describeFetchBudgetDenied,
  externalFetchBudgetLimit,
  LIVE_INSPECT_BUDGET_ENV_VAR,
  resetExternalFetchBudgetForTests,
  takeExternalFetchBudget,
} from "./_external-fetch-budget.js";

beforeEach(() => {
  resetExternalFetchBudgetForTests();
  delete process.env[LIVE_INSPECT_BUDGET_ENV_VAR];
});

afterEach(() => {
  delete process.env[LIVE_INSPECT_BUDGET_ENV_VAR];
});

describe("externalFetchBudgetLimit (#423 knob)", () => {
  it("defaults to 12 when the env var is unset or blank", () => {
    expect(externalFetchBudgetLimit()).toBe(12);
    process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = "  ";
    expect(externalFetchBudgetLimit()).toBe(12);
  });

  it("honours the env knob", () => {
    process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = "3";
    expect(externalFetchBudgetLimit()).toBe(3);
  });

  it("throws loudly on a malformed value, naming the variable (no-fallbacks)", () => {
    for (const bad of ["twelve", "0", "-1", "2.5"]) {
      process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = bad;
      expect(() => externalFetchBudgetLimit()).toThrow(LIVE_INSPECT_BUDGET_ENV_VAR);
    }
  });
});

describe("takeExternalFetchBudget", () => {
  it("grants up to the limit, then denies with reset info", () => {
    process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = "2";
    const a = takeExternalFetchBudget("session-x");
    expect(a.ok).toBe(true);
    expect(a.remaining).toBe(1);
    expect(a.limit).toBe(2);
    expect(a.windowMinutes).toBe(10);
    expect(a.retryAfterSeconds).toBeUndefined();

    expect(takeExternalFetchBudget("session-x").ok).toBe(true);

    const denied = takeExternalFetchBudget("session-x");
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.limit).toBe(2);
    // The oldest stamp is fresh, so the reset is near the full window.
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("keys budgets per chat session", () => {
    process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = "1";
    expect(takeExternalFetchBudget("s1").ok).toBe(true);
    expect(takeExternalFetchBudget("s1").ok).toBe(false);
    expect(takeExternalFetchBudget("s2").ok).toBe(true);
  });
});

describe("describeFetchBudgetDenied (#423 AI-actionable denial)", () => {
  it("names the limit, the reset window, and the config knob", () => {
    process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = "1";
    takeExternalFetchBudget("s-denial");
    const denied = takeExternalFetchBudget("s-denial");
    const msg = describeFetchBudgetDenied(denied);
    expect(msg).toContain("1 live fetches per 10-minute rolling window");
    expect(msg).toContain("frees up in ~");
    expect(msg).toContain(LIVE_INSPECT_BUDGET_ENV_VAR);
  });
});
