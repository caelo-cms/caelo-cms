// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { formatUpdateAgent } from "../caelo-updates.js";

const AGENT = {
  agentVersion: "0.10.47",
  host: "box-1",
  lastSeenAt: "2026-10-13T12:00:00.000Z",
  problem: null,
  checkedInRecently: true,
};

describe("get_caelo_update_agent — what the AI tells the operator (#696 Phase 4c)", () => {
  it("never claims the AI can install, whatever the agent's state", () => {
    for (const agent of [
      null,
      AGENT,
      { ...AGENT, checkedInRecently: false },
      { ...AGENT, problem: "cosign is missing." },
    ]) {
      const text = formatUpdateAgent(agent);
      expect(text).toContain("/settings/updates");
      if (agent) expect(text).toContain("You cannot");
    }
  });

  it("names what is wrong on the server", () => {
    expect(formatUpdateAgent(null)).toContain("No update agent has checked in");
    expect(formatUpdateAgent({ ...AGENT, checkedInRecently: false })).toContain("not running now");
    expect(formatUpdateAgent({ ...AGENT, problem: "cosign is missing." })).toContain(
      "cannot install updates: cosign is missing.",
    );
    expect(formatUpdateAgent(AGENT)).toContain("ready to install");
  });
});
