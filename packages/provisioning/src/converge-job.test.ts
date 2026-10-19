// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job (converge-job.ts, #819) against fakes: an in-memory
 * request queue, a fake signed manifest, a fake checkpoint store and a fake
 * upgrade. Checks the two stages (stage 1 only verifies and hands over to
 * the release's own signed installer; stage 2 converges under the state
 * lock), that a tampered manifest stops the job before any change, that a
 * killed run is resumed from its checkpoint, and that two runs never
 * converge at once.
 */

import { describe, expect, it } from "bun:test";
import type { StoredUpdatePolicy } from "@caelo-cms/shared";
import type { ConvergeCheckpoint } from "./converge-checkpoint.js";
import {
  type ConvergeClaim,
  type ConvergeJobDeps,
  type ConvergeQueue,
  type ConvergeUpgradeOutcome,
  runConvergeJob,
} from "./converge-job.js";
import type { ExecutionState } from "./install-job.js";
import type { InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import { StateLockHeldError } from "./state-store.js";
import type { UpgradeCheckpoint } from "./upgrade/upgrade.js";
import type { UpdateEnd, UpdateFacts } from "./upgrader-job.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const MANIFEST: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.11.0",
  channel: "stable",
  digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
  minFromVersion: "0.10.0",
  // Raises the contract: what the converge job exists for.
  infraContractVersion: 8,
  migrations: { contract: false, lastContractVersion: null, head: "0303_x" },
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
  securitySoakHours: 2,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  pausedUntil: null,
  pausedByOwner: false,
  updatedAt: "2026-10-19T00:00:00Z",
};

const META: InstallMetadata = {
  installId: "gcp-firebase-acme",
  provider: "gcp-firebase",
  projectId: "acme",
  domain: "acme.com",
  ownerEmail: "owner@acme.com",
  region: "europe-west1",
  createdAt: "2026-01-01T00:00:00Z",
  imageDigests: { admin: D("1"), gateway: D("2") },
  releaseVersion: "0.10.53",
  infraContractVersion: 7,
};

const BACKUP = { projectId: "acme", instance: "caelo-production-pg-x", backupId: "1760000000" };
const PRIOR = {
  admin: "caelo-production-admin-old-00001",
  gateway: "caelo-production-gw-old-00001",
};

/** In-memory queue: one request, recorded calls. */
function fakeQueue(claim: ConvergeClaim | null) {
  const events: { phase: string; level: string; message: string }[] = [];
  const ends: UpdateEnd[] = [];
  const facts: UpdateFacts[] = [];
  const handovers: { from: string | null; to: string | null }[] = [];
  let handoverAnswer = true;
  const queue: ConvergeQueue = {
    claimConverge: async () => claim,
    handover: async (_id, from, to) => {
      handovers.push({ from, to });
      return handoverAnswer;
    },
    event: async (_id, phase, level, message) => {
      events.push({ phase, level, message });
    },
    record: async (_id, f) => {
      facts.push(f);
    },
    finish: async (_id, end) => {
      ends.push(end);
      return true;
    },
  };
  return {
    queue,
    events,
    ends,
    facts,
    handovers,
    refuseHandover: () => {
      handoverAnswer = false;
    },
  };
}

const claimOf = (over: Partial<ConvergeClaim> = {}, trigger: "manual" | "auto" = "manual") => ({
  request: { id: REQUEST_ID, targetVersion: "0.11.0", trigger, autoBasis: null, policy: POLICY },
  resume: false,
  execution: "caelo-production-converge-run1",
  ...over,
});

interface Harness {
  readonly deps: ConvergeJobDeps;
  readonly calls: string[];
  readonly q: ReturnType<typeof fakeQueue>;
  readonly checkpoints: ConvergeCheckpoint[];
  readonly upgrades: { resume: UpgradeCheckpoint | undefined }[];
}

function harness(
  opts: {
    claim?: ConvergeClaim | null;
    ownVersion?: string;
    manifest?: ReleaseManifestResult;
    install?: InstallMetadata | null;
    ownDigest?: string | null;
    checkpoint?: ConvergeCheckpoint | null;
    executions?: Record<string, ExecutionState>;
    lock?: () => () => void;
    outcome?: ConvergeUpgradeOutcome;
    imageSigned?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const q = fakeQueue(opts.claim === undefined ? claimOf() : opts.claim);
  const checkpoints: ConvergeCheckpoint[] = [];
  const upgrades: { resume: UpgradeCheckpoint | undefined }[] = [];
  let stored = opts.checkpoint ?? null;
  const deps: ConvergeJobDeps = {
    queue: q.queue,
    projectId: "acme",
    execution: "caelo-production-converge-run1",
    ownVersion: opts.ownVersion ?? "0.11.0",
    fetchManifest: async (v) => {
      calls.push(`manifest ${v}`);
      return opts.manifest ?? { ok: true, manifest: MANIFEST };
    },
    readInstall: () => (opts.install === undefined ? META : opts.install),
    verifyImage: async (slug, digest) => {
      calls.push(`verify ${slug} ${digest}`);
      return opts.imageSigned ?? true;
    },
    ownImageDigest: async () => (opts.ownDigest === undefined ? D("c") : opts.ownDigest),
    pointJobAt: async (digest) => {
      calls.push(`point ${digest}`);
      return { ok: true };
    },
    startJob: async () => {
      calls.push("start");
      return { ok: true, execution: "caelo-production-converge-run2" };
    },
    executionState: async (name) => opts.executions?.[name] ?? "missing",
    lockState: () => {
      calls.push("lock");
      if (opts.lock) return opts.lock();
      return () => calls.push("unlock");
    },
    readCheckpoint: () => stored,
    writeCheckpoint: (c) => {
      calls.push(`checkpoint ${c.state}`);
      checkpoints.push(c);
      stored = c;
    },
    upgrade: async ({ resume, onCheckpoint }) => {
      calls.push("upgrade");
      upgrades.push({ resume });
      if (!resume?.priorRevisions) onCheckpoint({ priorRevisions: PRIOR });
      if (!resume?.backup) onCheckpoint({ backup: BACKUP });
      return opts.outcome ?? { ok: true, converged: true };
    },
    now: () => new Date("2026-10-19T12:00:00Z"),
    log: () => {},
  };
  return { deps, calls, q, checkpoints, upgrades };
}

const checkpointOf = (over: Partial<ConvergeCheckpoint> = {}): ConvergeCheckpoint => ({
  statusVersion: 1,
  installId: META.installId,
  execution: "caelo-production-converge-run0",
  state: "running",
  phase: "converge",
  caeloVersion: "0.11.0",
  startedAt: "2026-10-19T11:00:00Z",
  updatedAt: "2026-10-19T11:10:00Z",
  targetVersion: "0.11.0",
  fromVersion: "0.10.53",
  requestId: REQUEST_ID,
  backup: BACKUP,
  priorRevisions: PRIOR,
  ...over,
});

describe("runConvergeJob — stage 1 (the installed release's installer)", () => {
  it("verifies the manifest and the target's ops image, then hands over by digest and changes nothing else", async () => {
    const h = harness({ ownVersion: "0.10.53" });
    const r = await runConvergeJob(h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.status).toBeNull();
    expect(h.calls).toEqual([
      "manifest 0.11.0",
      `verify ops ${D("c")}`,
      "lock",
      `point ${D("c")}`,
      "unlock",
      "start",
    ]);
    // The request is released for the new run (before it exists), not ended.
    expect(h.q.ends).toEqual([]);
    expect(h.q.handovers).toEqual([{ from: "caelo-production-converge-run1", to: null }]);
    expect(h.upgrades).toEqual([]);
    expect(h.q.facts[0]?.opsDigest).toBe(D("c"));
  });

  it("an unsigned ops image stops the hand-over", async () => {
    const h = harness({ ownVersion: "0.10.53", imageSigned: false });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("refused");
    expect(h.calls.some((c) => /^(point|start)/.test(c))).toBe(false);
  });
});

describe("runConvergeJob — what stops the job before any change", () => {
  const nothingChanged = (h: Harness) => {
    expect(h.calls.some((c) => /^(lock|point|start|upgrade|checkpoint)/.test(c))).toBe(false);
  };

  it("a tampered or unsigned manifest", async () => {
    for (const stage of ["0.10.53", "0.11.0"]) {
      const h = harness({
        ownVersion: stage,
        manifest: { ok: false, error: { code: "signature", message: "no valid signature" } },
      });
      const r = await runConvergeJob(h.deps);
      expect(r.status).toBe("refused");
      expect(h.q.ends[0]?.codes).toEqual(["signature"]);
      nothingChanged(h);
    }
  });

  it("a downgrade or the installed release", async () => {
    const h = harness({ install: { ...META, releaseVersion: "0.12.0" } });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("refused");
    expect(h.q.ends[0]?.codes).toEqual(["not-newer"]);
    nothingChanged(h);
  });

  it("an automatic request: the policy has no switch for cloud-setup changes", async () => {
    const h = harness({ claim: claimOf({}, "auto") });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("refused");
    expect(h.q.ends[0]?.codes).toEqual(["policy"]);
    nothingChanged(h);
  });

  it("an install whose records are not in its own project", async () => {
    const h = harness({ install: null });
    expect((await runConvergeJob(h.deps)).status).toBe("needs_cloud_shell");
    nothingChanged(h);
  });

  it("stage 2 whose own image is not the one the manifest signs", async () => {
    const h = harness({ ownDigest: D("9") });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("refused");
    expect(h.q.ends[0]?.codes).toEqual(["ops-image"]);
    nothingChanged(h);
  });

  it("another live install operation holding the state lock", async () => {
    const h = harness({
      lock: () => {
        throw new StateLockHeldError("held by cms-provision upgrade");
      },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("failed");
    expect(h.q.ends[0]?.codes).toEqual(["state-locked"]);
    expect(h.q.ends[0]?.reason).toStartWith("Nothing was changed");
    expect(h.upgrades).toEqual([]);
  });
});

describe("runConvergeJob — stage 2 (the target release's own installer)", () => {
  it("checkpoints before the first change, converges under the lock, records the end", async () => {
    const h = harness();
    const r = await runConvergeJob(h.deps);
    expect(r).toEqual({ exitCode: 0, requestId: REQUEST_ID, status: "succeeded" });
    const first = h.calls.indexOf("checkpoint running");
    expect(h.calls.indexOf("lock")).toBeLessThan(first);
    expect(first).toBeLessThan(h.calls.indexOf("upgrade"));
    expect(h.calls.at(-1)).toBe("unlock");
    expect(h.upgrades).toEqual([{ resume: undefined }]);
    // The backup and the rollback targets reached the checkpoint as they came.
    const last = h.checkpoints.at(-1);
    expect(last?.state).toBe("succeeded");
    expect(last?.backup).toEqual(BACKUP);
    expect(last?.priorRevisions).toEqual(PRIOR);
    expect(h.q.ends[0]?.status).toBe("succeeded");
  });

  it("a release that failed its checks ends rolled back and keeps the checkpoint for a retry", async () => {
    const h = harness({ outcome: { ok: false, rolledBack: true, unrecorded: false } });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("rolled_back");
    expect(r.exitCode).toBe(1);
    expect(h.checkpoints.at(-1)?.state).toBe("failed");
    expect(h.checkpoints.at(-1)?.backup).toEqual(BACKUP);
  });

  it("a roll install.json could not record fails the run (no fallbacks)", async () => {
    const h = harness({ outcome: { ok: false, rolledBack: false, unrecorded: true } });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("failed");
    expect(h.q.ends[0]?.codes).toEqual(["record"]);
  });
});

describe("runConvergeJob — resume after a killed run", () => {
  it("a run that died is adopted once Cloud Run says it ended, and resumes from the checkpoint", async () => {
    const h = harness({
      claim: claimOf({ resume: true, execution: "caelo-production-converge-run0" }),
      // The killed run had already recorded the new release.
      install: { ...META, releaseVersion: "0.11.0" },
      checkpoint: checkpointOf(),
      executions: { "caelo-production-converge-run0": "failed" },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("succeeded");
    expect(h.q.handovers).toEqual([
      { from: "caelo-production-converge-run0", to: "caelo-production-converge-run1" },
    ]);
    // Judged from where the update started, not from the half-written records.
    expect(h.q.ends[0]?.codes).toEqual([]);
    // No second backup, the original rollback targets.
    expect(h.upgrades).toEqual([{ resume: { backup: BACKUP, priorRevisions: PRIOR } }]);
    expect(h.q.events.some((e) => e.message.startsWith("Continuing the update"))).toBe(true);
  });

  it("never runs while the previous execution is still alive", async () => {
    const h = harness({
      claim: claimOf({ resume: true, execution: "caelo-production-converge-run0" }),
      checkpoint: checkpointOf(),
      executions: { "caelo-production-converge-run0": "running" },
    });
    const r = await runConvergeJob(h.deps);
    expect(r).toEqual({ exitCode: 0, requestId: REQUEST_ID, status: null });
    expect(h.q.handovers).toEqual([]);
    expect(h.q.ends).toEqual([]);
    expect(h.q.events).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("leaves the request alone when another run adopted it first", async () => {
    const h = harness({
      claim: claimOf({ resume: true, execution: "caelo-production-converge-run0" }),
      executions: { "caelo-production-converge-run0": "failed" },
    });
    h.q.refuseHandover();
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBeNull();
    expect(h.q.ends).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("the stage-2 run adopts the request stage 1 released, without waiting for stage 1 to exit", async () => {
    const h = harness({
      claim: claimOf({ resume: true, execution: null }),
      executions: { "caelo-production-converge-run0": "running" },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("succeeded");
    expect(h.q.handovers).toEqual([{ from: null, to: "caelo-production-converge-run1" }]);
  });

  it("a stage-1 hand-over whose new run cannot start ends the request with nothing changed", async () => {
    const h = harness({ ownVersion: "0.10.53" });
    const deps = {
      ...h.deps,
      startJob: async () => ({ ok: false as const, error: "quota" }),
    };
    const r = await runConvergeJob(deps);
    expect(r.status).toBe("failed");
    expect(h.q.ends[0]?.codes).toEqual(["handover"]);
    expect(h.q.ends[0]?.reason).toStartWith("Nothing was changed");
  });

  it("a finished converge whose end was never recorded is finished, not repeated", async () => {
    const h = harness({
      claim: claimOf({ resume: true, execution: "caelo-production-converge-run0" }),
      install: { ...META, releaseVersion: "0.11.0", infraContractVersion: 8 },
      checkpoint: checkpointOf({ state: "succeeded" }),
      executions: { "caelo-production-converge-run0": "succeeded" },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("succeeded");
    expect(h.upgrades).toEqual([]);
    expect(h.calls.includes("lock")).toBe(false);
  });

  it("a checkpoint of another release starts fresh (new backup, new rollback targets)", async () => {
    const h = harness({ checkpoint: checkpointOf({ targetVersion: "0.10.99", state: "failed" }) });
    await runConvergeJob(h.deps);
    expect(h.upgrades).toEqual([{ resume: undefined }]);
  });

  it("an earlier stopped try at the same release reuses its backup and the takeover note says changes started", async () => {
    const h = harness({
      checkpoint: checkpointOf({ state: "failed" }),
      lock: () => {
        throw new StateLockHeldError("held");
      },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("failed");
    expect(h.q.ends[0]?.reason).toStartWith("This update already started changing the site");
  });
});

describe("runConvergeJob — nothing to do", () => {
  it("exits cleanly without a converge request", async () => {
    const h = harness({ claim: null });
    expect(await runConvergeJob(h.deps)).toEqual({ exitCode: 0, requestId: null, status: null });
  });
});
