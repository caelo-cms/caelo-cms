// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type AgentRunView,
  activeRuns,
  heldBackNote,
  mayStartTurn,
  runStatusText,
} from "./agent-runs-client.js";

const base: AgentRunView = {
  id: "r1",
  chatSessionId: "c1",
  chatTitle: "Homepage",
  kind: "turn",
  source: "live_edit",
  label: "Live Edit AI",
  state: "running",
  parentRunId: null,
  createdAt: "2026-10-12T13:00:00.000Z",
  heartbeatAt: "2026-10-12T13:00:00.000Z",
  cancelRequested: false,
};
const now = Date.parse("2026-10-12T13:02:00.000Z");

describe("mayStartTurn (issue #664)", () => {
  it("holds auto messages back after Stop and lets the operator through", () => {
    expect(mayStartTurn("auto", true)).toBe(false);
    expect(mayStartTurn("operator", true)).toBe(true);
    expect(mayStartTurn("auto", false)).toBe(true);
  });
});

describe("runStatusText", () => {
  it("describes every state", () => {
    expect(runStatusText(base, now)).toBe("working · 2 min");
    expect(runStatusText({ ...base, state: "queued" }, now)).toBe("waiting for the chat");
    expect(runStatusText({ ...base, cancelRequested: true }, now)).toBe("stopping…");
    expect(
      runStatusText({ ...base, kind: "mcp", heartbeatAt: "2026-10-12T13:01:30.000Z" }, now),
    ).toBe("working · last action 30s ago");
    expect(runStatusText({ ...base, kind: "mcp", state: "stopped" }, now)).toBe(
      "stopped — blocked in this chat",
    );
  });
});

describe("activeRuns", () => {
  it("counts only work that still runs", () => {
    const runs = [
      base,
      { ...base, id: "r2", cancelRequested: true },
      { ...base, id: "r3", kind: "mcp" as const, state: "stopped" as const },
      { ...base, id: "r4", state: "queued" as const },
    ];
    expect(activeRuns(runs).map((r) => r.id)).toEqual(["r1", "r4"]);
  });
});

describe("heldBackNote", () => {
  it("quotes and truncates the held-back message", () => {
    expect(heldBackNote("Approved: x")).toContain('"Approved: x"');
    expect(heldBackNote("y".repeat(300))).toContain("…");
  });
});
