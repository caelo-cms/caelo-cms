// SPDX-License-Identifier: MPL-2.0

/**
 * One poll of the self-hosted host agent (agent/run.ts) against fakes:
 * heartbeat, claim, the refusal matrix (nothing of the target runs before
 * its signed manifest passed), the hand-over to the target release's CLI,
 * and what happens when that process records nothing.
 */

import { describe, expect, it } from "bun:test";
import type { StoredUpdatePolicy } from "@caelo-cms/shared";
import type { ReleaseManifest, ReleaseManifestResult } from "../release-manifest.js";
import type { SelfHostedRelease } from "../self-hosted-release.js";
import type { ClaimedUpdate, UpdateEnd, UpdateFacts } from "../upgrader-job.js";
import type { AgentHeartbeat, AgentQueue } from "./queue.js";
import { type AgentApplyRequest, type AgentRunDeps, runAgentOnce } from "./run.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;

const MANIFEST: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.11.0",
  channel: "stable",
  digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
  minFromVersion: "0.10.0",
  // A raised cloud contract: irrelevant on self-hosted.
  infraContractVersion: 7,
  migrations: { contract: false, lastContractVersion: null, head: "0270_platform_update_agent" },
  security: false,
  advisories: [],
};

const POLICY: StoredUpdatePolicy = {
  mode: "notify",
  autoSecurity: false,
  autoPatch: false,
  autoMinor: false,
  channel: "stable",
  windowStart: null,
  windowEnd: null,
  windowTimezone: "UTC",
  soakHours: 24,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  updatedAt: "2026-10-13T00:00:00Z",
};

const REQUEST: ClaimedUpdate = {
  id: "11111111-1111-4111-8111-111111111111",
  targetVersion: "0.11.0",
  trigger: "manual",
  policy: POLICY,
};

const INSTALLED: SelfHostedRelease = {
  version: "0.10.47",
  images: {
    admin: `ghcr.io/caelo-cms/admin@${D("1")}`,
    gateway: `ghcr.io/caelo-cms/gateway@${D("2")}`,
  },
  installedAt: "2026-10-01T00:00:00Z",
  history: [],
};

interface Memory {
  queue: AgentQueue;
  beats: AgentHeartbeat[];
  claims: (string | null)[];
  events: { phase: string; level: string; message: string }[];
  facts: UpdateFacts[];
  ends: UpdateEnd[];
  /** Whether the request is still running (finish only ends a running one). */
  running: boolean;
}

function memoryQueue(request: ClaimedUpdate | null, opts: { heartbeatFails?: boolean } = {}) {
  const m: Memory = {
    beats: [],
    claims: [],
    events: [],
    facts: [],
    ends: [],
    running: false,
    queue: undefined as unknown as AgentQueue,
  };
  m.queue = {
    heartbeat: async (beat) => {
      if (opts.heartbeatFails) throw new Error("password authentication failed");
      m.beats.push(beat);
    },
    claim: async (execution) => {
      m.claims.push(execution);
      m.running = request !== null;
      return request;
    },
    event: async (_id, phase, level, message) => {
      m.events.push({ phase, level, message });
    },
    record: async (_id, facts) => {
      m.facts.push(facts);
    },
    finish: async (_id, end) => {
      if (!m.running) return false;
      m.running = false;
      m.ends.push(end);
      return true;
    },
  };
  return m;
}

function setup(over: Partial<AgentRunDeps> = {}, request: ClaimedUpdate | null = REQUEST) {
  const q = memoryQueue(request);
  const applied: AgentApplyRequest[] = [];
  const locks = { taken: 0, released: 0 };
  const deps: AgentRunDeps = {
    queue: q.queue,
    agentVersion: "0.10.47",
    host: "box-1",
    preflight: async () => null,
    readInstalled: () => INSTALLED,
    fetchManifest: async (): Promise<ReleaseManifestResult> => ({ ok: true, manifest: MANIFEST }),
    lock: () => {
      locks.taken += 1;
      return () => {
        locks.released += 1;
      };
    },
    applyTarget: async (req) => {
      applied.push(req);
      // The target's CLI records the end itself.
      await q.queue.finish(req.requestId, {
        status: "succeeded",
        reason: null,
        codes: [],
        pauseAutoUpdates: false,
      });
      return { exitCode: 0, output: "" };
    },
    now: () => new Date("2026-10-13T12:00:00Z"),
    log: () => {},
    sleep: async () => {},
    ...over,
  };
  return { deps, q, applied, locks };
}

describe("runAgentOnce", () => {
  it("checks in and does nothing more without a pending request", async () => {
    const { deps, q, applied } = setup({ preflight: async () => "cosign is missing" }, null);
    expect(await runAgentOnce(deps)).toEqual({ exitCode: 0, requestId: null, status: null });
    expect(q.beats).toEqual([
      { agentVersion: "0.10.47", host: "box-1", problem: "cosign is missing" },
    ]);
    expect(q.claims).toEqual(["agent@box-1"]);
    expect(applied).toEqual([]);
  });

  it("fails the poll (exit 1) when it cannot check in, and claims nothing", async () => {
    const q = memoryQueue(REQUEST, { heartbeatFails: true });
    const { deps } = setup({ queue: q.queue });
    expect((await runAgentOnce(deps)).exitCode).toBe(1);
    expect(q.claims).toEqual([]);
  });

  it("verifies, decides, then hands the request to the target release's CLI", async () => {
    const { deps, q, applied, locks } = setup();
    const r = await runAgentOnce(deps);
    expect(r).toEqual({ exitCode: 0, requestId: REQUEST.id, status: null });
    expect(applied).toEqual([
      {
        requestId: REQUEST.id,
        targetVersion: "0.11.0",
        trigger: "manual",
        digests: { admin: D("a"), gateway: D("b") },
      },
    ]);
    expect(q.facts[0]).toMatchObject({ adminDigest: D("a"), manifestSecurity: false });
    expect(q.events.map((e) => e.phase)).toEqual(["start", "verify", "assess"]);
    expect(q.events.some((e) => /signed by Caelo's release workflow/.test(e.message))).toBe(true);
    expect(q.ends).toEqual([
      { status: "succeeded", reason: null, codes: [], pauseAutoUpdates: false },
    ]);
    expect(locks).toEqual({ taken: 1, released: 1 });
  });

  interface RefusalRow {
    readonly name: string;
    readonly over: Partial<AgentRunDeps>;
    readonly request?: ClaimedUpdate;
    /** `<status>/<codes>`. */
    readonly expect: string;
    readonly reason?: RegExp;
  }
  const refusals: readonly RefusalRow[] = [
    {
      name: "a host problem (preflight)",
      over: { preflight: async () => "Docker is not reachable for the agent's user." },
      expect: "failed/preflight",
      reason: /Nothing was changed: Docker is not reachable/,
    },
    {
      name: "another upgrade holds the lock",
      over: {
        lock: () => {
          throw new Error("`cms-provision upgrade` is running on this install (pid 42).");
        },
      },
      expect: "failed/state-locked",
    },
    {
      name: "a malformed release.json",
      over: {
        readInstalled: () => {
          throw new Error("release.json is malformed");
        },
      },
      expect: "failed/install-state",
    },
    {
      name: "a bad signature",
      over: {
        fetchManifest: async () => ({ ok: false, error: { code: "signature", message: "no" } }),
      },
      expect: "refused/signature",
    },
    {
      name: "the registry is unreachable",
      over: {
        fetchManifest: async () => ({ ok: false, error: { code: "registry", message: "dns" } }),
      },
      expect: "failed/registry",
    },
    {
      name: "a downgrade",
      over: { readInstalled: () => ({ ...INSTALLED, version: "0.12.0" }) },
      expect: "refused/not-newer",
    },
    {
      name: "below minFromVersion",
      over: {
        fetchManifest: async () => ({
          ok: true,
          manifest: { ...MANIFEST, minFromVersion: "0.10.50" },
        }),
      },
      expect: "refused/min-from-version",
    },
    {
      name: "no recorded release (an install from before prebuilt images)",
      over: { readInstalled: () => null },
      expect: "needs_cloud_shell/install-version-unknown",
      reason: /upgrade command on the server/,
    },
    {
      name: "contract migrations on an automatic run",
      over: {
        fetchManifest: async () => ({
          ok: true,
          manifest: { ...MANIFEST, migrations: { ...MANIFEST.migrations, contract: true } },
        }),
      },
      request: {
        ...REQUEST,
        trigger: "auto",
        policy: { ...POLICY, mode: "auto", autoMinor: true },
      },
      expect: "refused/contract-migrations",
    },
    {
      name: "an automatic run the policy does not allow",
      over: {},
      request: { ...REQUEST, trigger: "auto" },
      expect: "refused/policy",
    },
  ];

  it.each(refusals.map((r) => [r.name, r] as const))(
    "stops before any target code runs: %s",
    async (_name, row) => {
      const { deps, q, applied, locks } = setup(row.over, row.request ?? REQUEST);
      const r = await runAgentOnce(deps);
      expect(applied).toEqual([]);
      const end = q.ends[0];
      expect(`${end?.status}/${end?.codes.join(",")}`).toBe(row.expect);
      if (row.reason) expect(end?.reason ?? "").toMatch(row.reason);
      expect(r.status).toBe(end?.status ?? null);
      expect(r.exitCode).toBe(end?.status === "failed" ? 1 : 0);
      // Whatever the lock did, it is not left held.
      expect(locks.released).toBe(locks.taken);
      expect(q.events.at(-1)?.phase).toBe("finish");
    },
  );

  it("ends the request as failed with the output when the target's CLI recorded nothing", async () => {
    const { deps, q } = setup({
      applyTarget: async () => ({ exitCode: 1, output: "error: package not found" }),
    });
    const r = await runAgentOnce(deps);
    expect(r).toEqual({ exitCode: 1, requestId: REQUEST.id, status: "failed" });
    expect(q.ends[0]?.status).toBe("failed");
    expect(q.ends[0]?.codes).toEqual(["apply"]);
    expect(q.ends[0]?.reason).toContain("error: package not found");
    expect(q.events.at(-1)).toMatchObject({ phase: "finish", level: "error" });
  });

  it("leaves a rolled-back end the target's CLI recorded alone", async () => {
    const { deps, q } = setup();
    const rolled: AgentRunDeps = {
      ...deps,
      applyTarget: async (req) => {
        await q.queue.finish(req.requestId, {
          status: "rolled_back",
          reason: "unhealthy",
          codes: ["roll-admin"],
          pauseAutoUpdates: false,
        });
        return { exitCode: 1, output: "" };
      },
    };
    const r = await runAgentOnce(rolled);
    expect(r).toEqual({ exitCode: 1, requestId: REQUEST.id, status: null });
    expect(q.ends.map((e) => e.status)).toEqual(["rolled_back"]);
    expect(q.events.some((e) => e.phase === "finish")).toBe(false);
  });

  it("pauses automatic installs when an automatic run fails", async () => {
    const { deps, q } = setup(
      { preflight: async () => "cosign is missing." },
      { ...REQUEST, trigger: "auto" },
    );
    await runAgentOnce(deps);
    expect(q.ends[0]).toMatchObject({ status: "failed", pauseAutoUpdates: true });
  });
});
