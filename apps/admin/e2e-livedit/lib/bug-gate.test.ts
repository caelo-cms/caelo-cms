// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { gateBugReports, MAX_NEW_BUGS } from "./bug-gate.js";
import { findKnownBug, type KnownBug } from "./known-bugs.js";

const LEDGER: KnownBug[] = [
  { issue: 123, tool: "stage_changes", match: /no page serves the site root/ },
];

function row(
  suspectedTool: string | null,
  whatHappened: string,
  forwarding: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: `Tool ${suspectedTool} returned an error`,
    whatHappened,
    suspectedTool,
    source: "auto",
    ...forwarding,
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

  // v0.11.0 cut — single new reports no longer block; they are filed as
  // issues through the bug intake. More than MAX_NEW_BUGS still fail.
  it("passes up to MAX_NEW_BUGS new reports and names each one's issue", () => {
    expect(MAX_NEW_BUGS).toBe(5);
    const raw = JSON.stringify([
      row("add_module", "Internal link check failed", {
        forwardingState: "sent",
        upstreamIssueUrl: "https://github.com/caelo-cms/caelo-cms/issues/9001",
      }),
      row("edit_module", "module not found", { forwardingState: "queued" }),
    ]);
    const result = gateBugReports(raw, LEDGER);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toStartWith("NEW [add_module]");
    expect(result.lines[0]).toContain("issues/9001");
    expect(result.lines[1]).toContain("NOT forwarded (queued)");
    expect(result.unforwarded).toBe(1);
  });

  it("fails on more than MAX_NEW_BUGS new reports", () => {
    const six = Array.from({ length: MAX_NEW_BUGS + 1 }, (_, i) =>
      row("add_module", `failure ${i}`, { forwardingState: "sent" }),
    );
    const result = gateBugReports(JSON.stringify(six), LEDGER);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toContain(`more than ${MAX_NEW_BUGS}`);
    const five = JSON.stringify(six.slice(1));
    expect(gateBugReports(five, LEDGER).ok).toBe(true);
  });

  it("fails when the capture failed instead of reading it as clean", () => {
    expect(gateBugReports("{}", LEDGER).ok).toBe(false);
    expect(gateBugReports("", LEDGER).ok).toBe(false);
  });
});
