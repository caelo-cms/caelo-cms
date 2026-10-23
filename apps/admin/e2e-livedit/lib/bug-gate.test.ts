// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { gateBugReports } from "./bug-gate.js";
import { findKnownBug, type KnownBug } from "./known-bugs.js";

const LEDGER: KnownBug[] = [
  { issue: 123, tool: "stage_changes", match: /no page serves the site root/ },
];

function row(suspectedTool: string | null, whatHappened: string): Record<string, unknown> {
  return {
    title: `Tool ${suspectedTool} returned an error`,
    whatHappened,
    suspectedTool,
    source: "auto",
  };
}

describe("findKnownBug", () => {
  it("matches on tool and message", () => {
    const hit = findKnownBug(
      {
        suspectedTool: "stage_changes",
        title: "t",
        whatHappened: "x: no page serves the site root '/'",
      },
      LEDGER,
    );
    expect(hit?.issue).toBe(123);
  });

  it("does not match the same message from another tool", () => {
    const miss = findKnownBug(
      { suspectedTool: "build_page", title: "t", whatHappened: "no page serves the site root" },
      LEDGER,
    );
    expect(miss).toBeUndefined();
  });
});

describe("gateBugReports", () => {
  it("passes a clean run", () => {
    expect(gateBugReports("[]", LEDGER).ok).toBe(true);
  });

  it("passes when every report is in the ledger", () => {
    const raw = JSON.stringify([row("stage_changes", "no page serves the site root '/'")]);
    const result = gateBugReports(raw, LEDGER);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toStartWith("known (#123)");
  });

  it("fails on a report the ledger does not know", () => {
    const raw = JSON.stringify([row("add_module", "Internal link check failed")]);
    const result = gateBugReports(raw, LEDGER);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toStartWith("NEW [add_module]");
  });

  it("fails when the capture failed instead of reading it as clean", () => {
    expect(gateBugReports("{}", LEDGER).ok).toBe(false);
    expect(gateBugReports("", LEDGER).ok).toBe(false);
  });
});
