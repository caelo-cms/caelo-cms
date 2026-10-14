// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import { agentInstallCommand, agentUpgraderTrigger } from "./agent-trigger.js";
import { UpgraderTriggerError } from "./job-trigger.js";

const AGENT: PlatformUpdateAgentStatus = {
  agentVersion: "0.10.47",
  host: "box-1",
  lastSeenAt: "2026-10-13T12:00:00.000Z",
  problem: null,
  checkedInRecently: true,
};

async function startWith(agent: PlatformUpdateAgentStatus | null) {
  try {
    return { started: await agentUpgraderTrigger(async () => agent).start() };
  } catch (e) {
    expect(e).toBeInstanceOf(UpgraderTriggerError);
    return { error: (e as Error).message, nextStep: (e as UpgraderTriggerError).nextStep };
  }
}

describe("agentUpgraderTrigger — self-hosted installs (#696 Phase 4c)", () => {
  it("queues for a running agent and names it", async () => {
    expect(await startWith(AGENT)).toEqual({ started: "agent@box-1" });
  });

  it("refuses when no agent ever checked in, with the command that sets it up", async () => {
    const r = await startWith(null);
    expect(r.error).toContain("not set up");
    expect(r.nextStep).toContain(agentInstallCommand());
    expect(agentInstallCommand("0.11.0")).toBe("bunx @caelo-cms/provisioning@0.11.0 agent install");
  });

  it("refuses a silent agent and one that reports a problem", async () => {
    expect((await startWith({ ...AGENT, checkedInRecently: false })).error).toContain(
      "has not checked in since",
    );
    expect((await startWith({ ...AGENT, problem: "cosign is missing." })).error).toContain(
      "cosign is missing.",
    );
  });

  it("has no run of its own to report", async () => {
    expect(await agentUpgraderTrigger(async () => AGENT).latest()).toBeNull();
  });
});
