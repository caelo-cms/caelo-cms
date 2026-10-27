// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  budgetVerdict,
  DEFAULT_WEEKLY_BUDGET_USD,
  ledgerFileName,
  parseBudgetUsd,
  parseLedgerName,
  staleLedgerNames,
  trailingSpend,
} from "./budget.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
/** $5 in microcents — the measured average run. */
const FIVE_USD = 500_000_000;

describe("ledger names", () => {
  it("round-trips time, run and cost", () => {
    const name = ledgerFileName(
      new Date("2026-10-26T20:03:03.456Z"),
      "40392177029",
      "2",
      776_000_000,
    );
    expect(name).toBe("20261026T200303Z_40392177029-2_776000000.json");
    expect(parseLedgerName(name)).toEqual({
      at: new Date("2026-10-26T20:03:03Z"),
      run: "40392177029-2",
      microcents: 776_000_000,
    });
  });

  it("ignores foreign files and refuses a non-numeric run id", () => {
    expect(parseLedgerName("README.md")).toBeNull();
    expect(parseLedgerName("20261026T200303Z_x-1_5.json")).toBeNull();
    expect(() => ledgerFileName(NOW, "../x", "1", 1)).toThrow(/numeric/);
  });
});

describe("trailingSpend", () => {
  it("sums only the last 7 days", () => {
    const names = [
      ledgerFileName(daysAgo(1), "1", "1", FIVE_USD),
      ledgerFileName(daysAgo(6.9), "2", "1", FIVE_USD),
      ledgerFileName(daysAgo(7.1), "3", "1", FIVE_USD),
      ledgerFileName(daysAgo(8), "4", "1", FIVE_USD),
      "README.md",
    ];
    expect(trailingSpend(names, NOW)).toBe(2 * FIVE_USD);
    expect(staleLedgerNames(names, NOW)).toEqual([]);
    expect(staleLedgerNames([ledgerFileName(daysAgo(10), "5", "1", 1)], NOW).length).toBe(1);
  });

  it("counts every attempt of a run (each re-run is new spend)", () => {
    const names = [
      ledgerFileName(daysAgo(1), "9", "1", FIVE_USD),
      ledgerFileName(daysAgo(1), "9", "2", FIVE_USD),
    ];
    expect(trailingSpend(names, NOW)).toBe(2 * FIVE_USD);
  });
});

describe("budget verdict", () => {
  it("defaults to the documented budget and rejects junk", () => {
    expect(parseBudgetUsd(undefined)).toBe(DEFAULT_WEEKLY_BUDGET_USD);
    expect(parseBudgetUsd("")).toBe(DEFAULT_WEEKLY_BUDGET_USD);
    expect(parseBudgetUsd("180")).toBe(180);
    expect(() => parseBudgetUsd("lots")).toThrow(/E2E_LIVEDIT_WEEKLY_BUDGET_USD/);
  });

  it("is over at or above the budget and says where runs still happen", () => {
    const over = budgetVerdict(50 * FIVE_USD, 250);
    expect(over.over).toBe(true);
    expect(over.line).toBe(
      "Real-AI weekly budget used: $250.00 of $250.00 (trailing 7 days) — runs on the release gate (or a dispatch with override_budget) only.",
    );
    const under = budgetVerdict(10 * FIVE_USD, 250);
    expect(under.over).toBe(false);
    expect(under.line).toContain("$50.00 of $250.00");
  });
});
