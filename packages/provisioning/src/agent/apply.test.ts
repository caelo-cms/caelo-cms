// SPDX-License-Identifier: MPL-2.0

/**
 * The target release's half of a self-hosted update (agent/apply.ts): the
 * upgrade's progress becomes the request's timeline, its result the
 * request's end state, and only a successful install re-pins the agent.
 */

import { describe, expect, it } from "bun:test";
import type { SelfHostedUpgradeResult, UpgradeLog } from "../self-hosted-upgrade.js";
import type { UpdateEnd, UpdateQueue } from "../upgrader-job.js";
import { type AgentApplyDeps, applyAgentUpdate, endForResult } from "./apply.js";

const REQUEST = {
  id: "22222222-2222-4222-8222-222222222222",
  targetVersion: "0.11.0",
  trigger: "manual" as const,
};

function setup(
  upgrade: (log: UpgradeLog) => Promise<SelfHostedUpgradeResult>,
  over: Partial<AgentApplyDeps> = {},
) {
  const events: { phase: string; level: string; message: string }[] = [];
  const ends: UpdateEnd[] = [];
  let pins = 0;
  const queue: UpdateQueue = {
    claim: async () => null,
    event: async (_id, phase, level, message) => {
      events.push({ phase, level, message });
    },
    record: async () => {},
    finish: async (_id, end) => {
      ends.push(end);
      return true;
    },
  };
  const deps: AgentApplyDeps = {
    queue,
    request: REQUEST,
    agentVersion: "0.11.0",
    upgrade,
    selfUpdate: async () => {
      pins += 1;
      return { ok: true };
    },
    log: () => {},
    sleep: async () => {},
    ...over,
  };
  return { deps, events, ends, pins: () => pins };
}

/** An upgrade that narrates like upgradeSelfHosted does. */
const narrated =
  (result: SelfHostedUpgradeResult) =>
  async (log: UpgradeLog): Promise<SelfHostedUpgradeResult> => {
    log.phase?.("verify");
    log.info("Verifying the signature of admin");
    log.phase?.("backup");
    log.step("Backing up the databases (pg_dump)");
    log.phase?.("migrations");
    log.step("Running database migrations with the new admin image");
    log.phase?.("roll");
    log.step("Restarting admin on sha256:aaaa");
    if (!result.ok) {
      log.phase?.("rollback");
      log.warn("Rolling back to the previous images");
    } else {
      log.phase?.("record");
    }
    return result;
  };

describe("applyAgentUpdate", () => {
  it("narrates the upgrade into the timeline, records success, re-pins the agent", async () => {
    const { deps, events, ends, pins } = setup(
      narrated({ ok: true, status: "upgraded", version: "0.11.0" }),
    );
    expect(await applyAgentUpdate(deps)).toEqual({ exitCode: 0 });
    expect([...new Set(events.map((e) => e.phase))]).toEqual([
      "start",
      "verify",
      "backup",
      "migrations",
      "roll",
      "self-update",
      "finish",
    ]);
    expect(ends).toEqual([
      { status: "succeeded", reason: null, codes: [], pauseAutoUpdates: false },
    ]);
    expect(pins()).toBe(1);
  });

  it("ends a rolled-back upgrade as rolled_back and leaves the agent's pin", async () => {
    const { deps, events, ends, pins } = setup(
      narrated({
        ok: false,
        stage: "roll-admin",
        error: "health check did not pass",
        previousRunning: true,
      }),
    );
    expect(await applyAgentUpdate(deps)).toEqual({ exitCode: 1 });
    expect(ends[0]).toMatchObject({ status: "rolled_back", codes: ["roll-admin"] });
    expect(ends[0]?.reason).toContain("previous release serves again");
    expect(events.some((e) => e.phase === "rollback")).toBe(true);
    expect(pins()).toBe(0);
  });

  it("refuses to act as another release than the target", async () => {
    let ran = false;
    const { deps, ends } = setup(
      async () => {
        ran = true;
        return { ok: true, status: "upgraded", version: "0.11.0" };
      },
      { agentVersion: "0.10.47" },
    );
    expect(await applyAgentUpdate(deps)).toEqual({ exitCode: 1 });
    expect(ran).toBe(false);
    expect(ends[0]).toMatchObject({ status: "failed", codes: ["apply"] });
  });

  it("turns a thrown upgrade into a failed request", async () => {
    const { deps, ends } = setup(async () => {
      throw new Error("ENOSPC");
    });
    expect(await applyAgentUpdate(deps)).toEqual({ exitCode: 1 });
    expect(ends[0]).toMatchObject({ status: "failed", codes: ["internal"] });
    expect(ends[0]?.reason).toContain("ENOSPC");
  });

  it("still succeeds when the agent cannot re-pin itself, with a warning", async () => {
    const { deps, events, ends } = setup(
      narrated({ ok: true, status: "upgraded", version: "0.11.0" }),
      { selfUpdate: async () => ({ ok: false, error: "read-only home" }) },
    );
    expect(await applyAgentUpdate(deps)).toEqual({ exitCode: 0 });
    expect(ends[0]?.status).toBe("succeeded");
    expect(events.find((e) => e.phase === "self-update")).toMatchObject({ level: "warn" });
  });
});

describe("endForResult", () => {
  it.each([
    [
      "verify failure",
      { ok: false, stage: "verify", error: "cosign", previousRunning: true } as const,
      "failed",
      "verify",
    ],
    [
      "migration failure",
      { ok: false, stage: "migrate", error: "x", previousRunning: true } as const,
      "failed",
      "migrate",
    ],
    [
      "gateway rolled back",
      { ok: false, stage: "roll-gateway", error: "x", previousRunning: true } as const,
      "rolled_back",
      "roll-gateway",
    ],
    [
      "rollback failed",
      { ok: false, stage: "roll-admin", error: "x", previousRunning: false } as const,
      "failed",
      "rollback",
    ],
  ])("%s", (_name, result, status, code) => {
    const end = endForResult(result, "auto");
    expect(end.status).toBe(status as UpdateEnd["status"]);
    expect(end.codes).toEqual([code]);
    expect(end.pauseAutoUpdates).toBe(true);
  });

  it("does not pause automatic installs after a manual failure", () => {
    expect(
      endForResult({ ok: false, stage: "pull", error: "x", previousRunning: true }, "manual")
        .pauseAutoUpdates,
    ).toBe(false);
  });
});
