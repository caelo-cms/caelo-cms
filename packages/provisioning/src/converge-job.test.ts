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
  SELF_GRANT_RECHECK_ATTEMPTS,
  type SecureDatabaseResult,
} from "./converge-job.js";
import type { ExecutionState } from "./install-job.js";
import type { InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import { StateLockHeldError } from "./state-store.js";
import type { UpgradeCheckpoint } from "./upgrade/upgrade.js";
import { type IamTester, resourceName } from "./upgrader-iam-preflight.js";
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
    /** What IAM answers the self-check; every permission asked for by default. */
    iam?: IamTester;
    /** #1373 — the database TLS step's answer; null: the queue dials the DNS name already. */
    secureDatabase?: SecureDatabaseResult | null;
    /** What a self-grant answers; ok by default. */
    grant?: (role: string) => { ok: true } | { ok: false; error: string };
  } = {},
): Harness {
  const calls: string[] = [];
  const q = fakeQueue(opts.claim === undefined ? claimOf() : opts.claim);
  const checkpoints: ConvergeCheckpoint[] = [];
  const upgrades: { resume: UpgradeCheckpoint | undefined }[] = [];
  let stored = opts.checkpoint ?? null;
  const deps: ConvergeJobDeps = {
    queue: q.queue,
    secureDatabase:
      opts.secureDatabase === undefined || opts.secureDatabase === null
        ? null
        : async () => {
            calls.push("secure database");
            return opts.secureDatabase as SecureDatabaseResult;
          },
    projectId: "acme",
    region: "europe-west1",
    iam: opts.iam ?? {
      granted: async (_resource, permissions) => ({ ok: true, granted: permissions }),
    },
    grantOwnRole: async (role) => {
      calls.push(`grant ${role}`);
      return opts.grant ? opts.grant(role) : { ok: true };
    },
    sleep: async () => {
      calls.push("sleep");
    },
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
    // Stage 1 runs an earlier release's image, stage 2 the manifest's.
    ownImageDigest: async () =>
      opts.ownDigest !== undefined
        ? opts.ownDigest
        : (opts.ownVersion ?? "0.11.0") === "0.11.0"
          ? D("c")
          : D("e"),
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

  it("#884: a missing grant stops either stage before the lock, every missing one named", async () => {
    // The provisioner lost cloudscheduler.admin and actAs on itself.
    const iam: IamTester = {
      granted: async (resource, permissions) => ({
        ok: true,
        granted: permissions.filter(
          (p) =>
            !p.startsWith("cloudscheduler.") &&
            !(resource.kind === "service-account" && p === "iam.serviceAccounts.actAs"),
        ),
      }),
    };
    for (const stage of ["0.10.53", "0.11.0"]) {
      const h = harness({ ownVersion: stage, iam });
      const r = await runConvergeJob(h.deps);
      expect(r.status).toBe("needs_cloud_shell");
      nothingChanged(h);
      expect(h.q.ends[0]?.codes).toEqual(["iam-preflight"]);
      const reason = h.q.ends[0]?.reason ?? "";
      expect(reason).toStartWith("Nothing was changed: the converge job checked its access");
      expect(reason).toContain("cloudscheduler.jobs.create");
      expect(reason).toContain(
        "projects/acme/serviceAccounts/caelo-provisioner@acme.iam.gserviceaccount.com",
      );
      expect(reason).toContain("repairs the converge job's access");
    }
  });

  it("#884: IAM that cannot be asked fails the run before the lock", async () => {
    const h = harness({
      iam: {
        granted: async (resource) =>
          resource.kind === "bucket" ? { ok: false, error: "HTTP 503" } : { ok: true, granted: [] },
      },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("failed");
    nothingChanged(h);
    expect(h.q.ends[0]?.reason).toContain(
      `${resourceName({ kind: "bucket", bucket: "acme-caelo-ops" })}: HTTP 503`,
    );
  });

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

  it("stage 2 accepts the signed linux/amd64 form Cloud Run reports for its own image (#1025)", async () => {
    const h = harness({
      manifest: {
        ok: true,
        manifest: { ...MANIFEST, platformDigests: { admin: D("1"), gateway: D("2"), ops: D("3") } },
      },
      ownDigest: D("3"),
    });
    const r = await runConvergeJob(h.deps);
    expect(h.q.ends[0]?.codes ?? []).not.toContain("ops-image");
    expect(h.calls).toContain("upgrade");
    expect(r.exitCode).toBe(0);
  });

  it("stage 2 refuses a platform digest the manifest does not sign", async () => {
    const h = harness({
      manifest: {
        ok: true,
        manifest: { ...MANIFEST, platformDigests: { admin: D("1"), gateway: D("2"), ops: D("3") } },
      },
      ownDigest: D("1"),
    });
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

  it("#883 review: install.json changed between the decision and the lock stops before any change", async () => {
    // Judged against one record, but the upgrader job (or a terminal
    // upgrade) wrote another before this run held the lock.
    const h = harness();
    let reads = 0;
    const r = await runConvergeJob({
      ...h.deps,
      readInstall: () => {
        reads += 1;
        return reads === 1 ? META : { ...META, releaseVersion: "0.10.54" };
      },
    });
    expect(r.status).toBe("failed");
    expect(h.q.ends[0]?.codes).toEqual(["install-state-changed"]);
    expect(h.q.ends[0]?.reason).toStartWith("Nothing was changed:");
    expect(h.upgrades).toEqual([]);
    expect(h.checkpoints).toEqual([]);
    expect(h.calls.at(-1)).toBe("unlock");

    // A re-read that fails is loud too, never a converge on the old view.
    const failing = harness();
    let n = 0;
    const r2 = await runConvergeJob({
      ...failing.deps,
      readInstall: () => {
        n += 1;
        if (n > 1) throw new Error("storage.objects.get timed out");
        return META;
      },
    });
    expect(r2.status).toBe("failed");
    expect(failing.q.ends[0]?.codes).toEqual(["install-state-read"]);
    expect(failing.upgrades).toEqual([]);
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

/**
 * An IAM that lacks the workflows.* permissions (an install set up before
 * 0.11.11 added roles/workflows.editor, the searchviu-website case) until
 * the job granted the role, and confirms it `lag` asks later.
 */
function lacksWorkflows(lag = 0, extraMissing: (p: string) => boolean = () => false) {
  const state = { granted: false, asksSinceGrant: 0 };
  const iam: IamTester = {
    granted: async (_resource, permissions) => {
      if (state.granted) state.asksSinceGrant += 1;
      const workflowsHeld = state.granted && state.asksSinceGrant > lag;
      return {
        ok: true,
        granted: permissions.filter(
          (p) => !extraMissing(p) && (workflowsHeld || !p.startsWith("workflows.")),
        ),
      };
    },
  };
  const grant = (role: string) => {
    if (role === "roles/workflows.editor") state.granted = true;
    return { ok: true } as const;
  };
  return { iam, grant };
}

describe("runConvergeJob — the job grants itself the roles its release names (2026-11-03)", () => {
  it("stage 1 leaves a missing allowlisted role to stage 2 and hands over without granting", async () => {
    const { iam, grant } = lacksWorkflows();
    const h = harness({ ownVersion: "0.10.53", iam, grant });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBeNull();
    expect(h.calls.some((c) => c.startsWith("grant"))).toBe(false);
    expect(h.calls).toContain("start");
    expect(h.q.ends).toEqual([]);
    expect(
      h.q.events.some(
        (e) =>
          e.message.includes("lacks roles/workflows.editor") &&
          e.message.includes("The installer of 0.11.0 grants them"),
      ),
    ).toBe(true);
  });

  it("stage 2 grants the role after the image check and under the lock, records it, re-checks, converges", async () => {
    const { iam, grant } = lacksWorkflows();
    const h = harness({ iam, grant });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("succeeded");
    const g = h.calls.indexOf("grant roles/workflows.editor");
    expect(g).toBeGreaterThan(h.calls.indexOf("lock"));
    expect(g).toBeLessThan(h.calls.indexOf("checkpoint running"));
    expect(g).toBeLessThan(h.calls.indexOf("upgrade"));
    // Only the missing role, nothing else of the list.
    expect(h.calls.filter((c) => c.startsWith("grant"))).toEqual(["grant roles/workflows.editor"]);
    const event = h.q.events.find((e) => e.message.startsWith("Granted roles/workflows.editor"));
    expect(event?.level).toBe("success");
    expect(event?.message).toBe(
      "Granted roles/workflows.editor to the converge job's account (caelo-provisioner@acme.iam.gserviceaccount.com), needed by Caelo 0.11.0 to deploy and update the workflow the scheduler tick runs (#1140).",
    );
    expect(h.q.events.some((e) => e.message.startsWith("IAM confirms the granted roles"))).toBe(
      true,
    );
  });

  it("waits for IAM to confirm a fresh grant (propagation) before it goes on", async () => {
    const { iam, grant } = lacksWorkflows(3);
    const h = harness({ iam, grant });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("succeeded");
    const sleeps = h.calls.filter((c) => c === "sleep").length;
    expect(sleeps).toBeGreaterThan(0);
    expect(h.calls.lastIndexOf("sleep")).toBeLessThan(h.calls.indexOf("upgrade"));
  });

  it("a grant that fails (org policy) ends the request with the Cloud Shell step, before any change", async () => {
    const { iam } = lacksWorkflows();
    const h = harness({
      iam,
      grant: () => ({
        ok: false,
        error: "ERROR: (gcloud.projects.add-iam-policy-binding) FAILED_PRECONDITION: org policy",
      }),
    });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("needs_cloud_shell");
    expect(h.q.ends[0]?.codes).toEqual(["iam-self-grant"]);
    const reason = h.q.ends[0]?.reason ?? "";
    expect(reason).toStartWith(
      "Nothing was changed: the converge job could not grant its own account",
    );
    expect(reason).toContain("roles/workflows.editor");
    expect(reason).toContain("org policy");
    expect(reason).toContain("Run the update once from Cloud Shell");
    expect(h.upgrades).toEqual([]);
    expect(h.calls.some((c) => c.startsWith("checkpoint"))).toBe(false);
    expect(h.calls.at(-1)).toBe("unlock");
  });

  it("a grant IAM never confirms ends with the Cloud Shell step after the wait", async () => {
    const { iam, grant } = lacksWorkflows(10_000);
    const h = harness({ iam, grant });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("needs_cloud_shell");
    expect(h.q.ends[0]?.codes).toEqual(["iam-self-grant"]);
    expect(h.q.ends[0]?.reason).toContain("workflows.workflows.create");
    expect(h.calls.filter((c) => c === "sleep").length).toBe(SELF_GRANT_RECHECK_ATTEMPTS - 1);
    expect(h.upgrades).toEqual([]);
  });

  it("a missing permission no allowlisted role carries stops either stage without granting anything", async () => {
    // workflows.* is repairable, actAs on its own account is not.
    const { iam, grant } = lacksWorkflows(0, (p) => p === "iam.serviceAccounts.actAs");
    for (const stage of ["0.10.53", "0.11.0"]) {
      const h = harness({ ownVersion: stage, iam, grant });
      const r = await runConvergeJob(h.deps);
      expect(r.status).toBe("needs_cloud_shell");
      expect(h.q.ends[0]?.codes).toEqual(["iam-preflight"]);
      expect(h.calls.some((c) => /^(grant|lock|point|start|upgrade)/.test(c))).toBe(false);
      expect(h.q.ends[0]?.reason).toContain("workflows.workflows.create");
      expect(h.q.ends[0]?.reason).toContain("iam.serviceAccounts.actAs");
    }
  });

  it("stage 2 refuses an image the manifest does not sign before it grants anything", async () => {
    const { iam, grant } = lacksWorkflows();
    const h = harness({ iam, grant, ownDigest: D("9") });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("refused");
    expect(h.calls.some((c) => c.startsWith("grant"))).toBe(false);
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

  it("a stage-1 hand-over whose new run cannot start ends the request with the site unchanged", async () => {
    const h = harness({ ownVersion: "0.10.53" });
    const deps = {
      ...h.deps,
      startJob: async () => ({ ok: false as const, error: "quota" }),
    };
    const r = await runConvergeJob(deps);
    expect(r.status).toBe("failed");
    expect(h.q.ends[0]?.codes).toEqual(["handover"]);
    expect(h.q.ends[0]?.reason).toStartWith("Nothing on the site was changed");
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

describe("runConvergeJob — the database TLS step (#1373)", () => {
  const DNS = "abc.p-label.europe-west1.sql-psa.goog";

  it("a failed TLS step reaches the timeline and ends the request, before any roll", async () => {
    const h = harness({
      secureDatabase: {
        ok: false,
        error:
          "database TLS could not be set up: caelo-production-pg-1 reports no PRIVATE_SERVICES_ACCESS DNS name",
      },
    });
    const r = await runConvergeJob(h.deps);
    expect(r.exitCode).toBe(1);
    expect(r.status).toBe("failed");
    expect(h.upgrades).toEqual([]);
    // Under the lock, after the resumable checkpoint, released at the end.
    expect(h.calls).toEqual([
      "manifest 0.11.0",
      "lock",
      "checkpoint running",
      "secure database",
      "checkpoint failed",
      "unlock",
    ]);
    const end = h.q.ends[0];
    expect(end?.codes).toEqual(["database-tls"]);
    expect(end?.reason).toContain("reports no PRIVATE_SERVICES_ACCESS DNS name");
    // The step's start and its error are timeline events of the request.
    const converge = h.q.events.filter((e) => e.phase === "converge");
    expect(converge[0]?.message).toStartWith("Setting up verified encryption");
    const error = h.q.events.find((e) => e.level === "error");
    expect(error?.message).toContain("reports no PRIVATE_SERVICES_ACCESS DNS name");
  });

  it("a successful TLS step runs right before the upgrade and names the verified host", async () => {
    const h = harness({ secureDatabase: { ok: true, host: DNS } });
    const r = await runConvergeJob(h.deps);
    expect(r.status).toBe("succeeded");
    const at = h.calls.indexOf("secure database");
    expect(at).toBeGreaterThan(h.calls.indexOf("lock"));
    expect(h.calls[at + 1]).toBe("upgrade");
    expect(h.q.events.some((e) => e.level === "success" && e.message.includes(DNS))).toBe(true);
  });

  it("stage 1 never runs it: the release's own installer changes the database", async () => {
    const h = harness({ ownVersion: "0.10.53", secureDatabase: { ok: true, host: DNS } });
    await runConvergeJob(h.deps);
    expect(h.calls.includes("secure database")).toBe(false);
  });

  it("a stop before the lock leaves the database alone", async () => {
    const h = harness({
      secureDatabase: { ok: true, host: DNS },
      manifest: { ok: false, error: { code: "signature", message: "no valid signature" } },
    });
    await runConvergeJob(h.deps);
    expect(h.calls.includes("secure database")).toBe(false);
  });
});

describe("runConvergeJob — nothing to do", () => {
  it("exits cleanly without a converge request", async () => {
    const h = harness({ claim: null });
    expect(await runConvergeJob(h.deps)).toEqual({ exitCode: 0, requestId: null, status: null });
  });
});
