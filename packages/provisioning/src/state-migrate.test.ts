// SPDX-License-Identifier: MPL-2.0

/**
 * `state migrate` (#696, state-migrate.ts) against a fake Pulumi workspace
 * (backends as a Map) and fake side effects. Load-bearing: a round trip
 * local → remote → local keeps the stack identical and flips install.json
 * only after verification; any mismatch or failure leaves the source
 * authoritative and the copy discarded; a dry run changes nothing; an
 * unconverged or interrupted stack is refused before anything is touched.
 */

import { describe, expect, it } from "bun:test";
import type { PlannedStep } from "./preview-plan.js";
import {
  gcsBackendRecord,
  localStateNotice,
  type ResolvedBackend,
  resolveBackend,
  type StateBackendRecord,
} from "./state-backend.js";
import {
  type MigrateDeps,
  type MigrateInstall,
  migrateState,
  type StatePulumiOps,
  versionAtLeast,
} from "./state-migrate.js";
import { canonicalJson } from "./state-pulumi.js";
import type { UpgradeReporter } from "./upgrade/reporter.js";

interface FakeStack {
  outputs: Record<string, unknown>;
  secretsProvider: string;
  pending: number;
  drift: number;
  /** What the preview plans; `drift` in-place updates when unset. */
  plan?: PlannedStep[];
}

/** `n` in-place updates of IAM members, the shape most drift has. */
function updates(n: number): PlannedStep[] {
  return Array.from({ length: n }, (_, i) => ({
    op: "update" as const,
    type: "gcp:projects/iAMMember:IAMMember",
    name: `binding-${i}`,
    urn: `urn:pulumi:production::caelo-gcp-firebase::gcp:projects/iAMMember:IAMMember::binding-${i}`,
    diffs: ["member"],
    replaceReasons: [],
  }));
}

const ROOT = "/home/op/.caelo-gcp-firebase-acme";
const GCS = gcsBackendRecord("acme", "europe-west1");

function fakePulumi(version = "3.260.0") {
  const stacks = new Map<string, FakeStack>();
  const calls: string[] = [];
  const faults: {
    corruptCopy: boolean;
    copyFails: boolean;
    driftOnTarget: number;
    onStateDigest?: () => void;
    lockedUrl?: string;
  } = { corruptCopy: false, copyFails: false, driftOnTarget: 0 };
  const ops: StatePulumiOps = {
    async cliVersion() {
      return version;
    },
    async stackExists(b) {
      return stacks.has(b.url);
    },
    async pendingOperations(b) {
      return stacks.get(b.url)?.pending ?? 0;
    },
    async previewChanges(b) {
      const s = stacks.get(b.url);
      if (!s) throw new Error(`no stack in ${b.url}`);
      return s.plan ?? updates(s.drift);
    },
    async locked(b) {
      return faults.lockedUrl === b.url;
    },
    async stateDigest(b) {
      const s = stacks.get(b.url);
      if (!s) throw new Error(`no stack in ${b.url}`);
      faults.onStateDigest?.();
      return canonicalJson({ ...s, drift: 0 });
    },
    async outputsDigest(b) {
      const s = stacks.get(b.url);
      if (!s) throw new Error(`no stack in ${b.url}`);
      return canonicalJson(s.outputs);
    },
    async stackMigrate(from, to) {
      calls.push(`migrate ${from.url} -> ${to.url} (${to.secretsProvider})`);
      copy(from, to);
    },
    async exportImport(from, to) {
      calls.push(`export-import ${from.url} -> ${to.url} (${to.secretsProvider})`);
      copy(from, to);
    },
    async removeStack(b) {
      calls.push(`rm ${b.url}`);
      stacks.delete(b.url);
    },
  };
  function copy(from: ResolvedBackend, to: ResolvedBackend) {
    if (faults.copyFails) throw new Error("backend unavailable");
    const s = stacks.get(from.url);
    if (!s) throw new Error("no source");
    stacks.set(to.url, {
      outputs: faults.corruptCopy
        ? { ...s.outputs, adminUrl: "https://changed" }
        : { ...s.outputs },
      secretsProvider: to.secretsProvider,
      pending: 0,
      drift: faults.driftOnTarget,
    });
  }
  return { ops, stacks, calls, faults };
}

function recorder(): UpgradeReporter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    step: (label) => {
      lines.push(`step ${label}`);
      return {
        done: (m) => lines.push(`done ${m}`),
        failed: (m) => lines.push(`failed ${m}`),
        warned: (m) => lines.push(`warned ${m}`),
        progress: (m) => lines.push(`progress ${m}`),
      };
    },
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    success: (m) => lines.push(`success ${m}`),
  };
}

/** A machine: install.json's backend, the passphrase, the local dir. */
function machine(initial: StateBackendRecord = { kind: "local" }) {
  const p = fakePulumi();
  const m = {
    backend: initial,
    passphrase: "pp" as string | null,
    backups: 0,
    retired: [] as string[],
    ensureRemoteCalls: [] as boolean[],
    /** What the bucket's install.json names. */
    locked: false,
    acceptCost: true,
    bucketRecord: (initial.kind === "gcs" ? "gcs" : null) as "gcs" | "local" | null,
    planFiles: [] as { label: string; steps: number }[],
    /** What existingInProject answers (#1079); an Error is thrown. */
    existing: [] as readonly string[] | Error,
    /** What checkAdc answers (#1078). */
    adc: { ok: true } as { ok: true } | { ok: false; error: string },
    adcChecks: 0,
  };
  const meta = (): MigrateInstall => ({
    installId: "gcp-firebase-acme",
    provider: "gcp-firebase",
    projectId: "acme",
    region: "europe-west1",
    stateBackend: m.backend,
  });
  const report = recorder();
  const localUrl = `file://${ROOT}/state`;
  const deps: MigrateDeps = {
    pulumi: p.ops,
    report,
    checkAdc: async () => {
      m.adcChecks++;
      return m.adc;
    },
    resolve: (record) =>
      resolveBackend(
        { installId: "gcp-firebase-acme", stateBackend: record },
        { installRoot: ROOT, readPassphrase: () => m.passphrase },
      ),
    confirmCost: async () => m.acceptCost,
    ensureRemote: async (dry) => {
      m.ensureRemoteCalls.push(dry);
      return { ok: true, record: GCS, actions: dry ? ["would create gs://acme-caelo-ops"] : [] };
    },
    backup: async () => {
      m.backups++;
      return "/home/op/.caelo-backups/gcp-firebase-acme-x.tar.zst";
    },
    localStateEmpty: () => !p.stacks.has(localUrl),
    prepareLocalTarget: () => {
      m.passphrase ??= "new-pp";
    },
    remoteRecordedBackend: () => m.bucketRecord,
    lock: async () => {
      if (m.locked) throw new Error("Another state migration of this install is running");
      m.locked = true;
      return async () => {
        m.locked = false;
      };
    },
    adopt: (record) => {
      m.backend = record;
      m.bucketRecord = record.kind;
    },
    retireLocalState: () => {
      const s = p.stacks.get(localUrl);
      if (!s) return null;
      // Renamed: the stack no longer sits at the backend URL.
      p.stacks.delete(localUrl);
      m.retired.push(`${ROOT}/state.migrated-x`);
      return `${ROOT}/state.migrated-x`;
    },
    writePlan: (label, steps) => {
      m.planFiles.push({ label, steps: steps.length });
      return `${ROOT}/plan-${label}.txt`;
    },
    existingInProject: async () => {
      if (m.existing instanceof Error) throw m.existing;
      return m.existing;
    },
  };
  p.stacks.set(localUrl, {
    outputs: {
      adminUrl: "https://admin.acme.com",
      bootstrapUrlOut: "https://x/setup?token=s3cret",
    },
    secretsProvider: "passphrase",
    pending: 0,
    drift: 0,
  });
  return { p, m, meta, deps, report, localUrl, gcsUrl: "gs://acme-caelo-ops/pulumi" };
}

describe("migrateState — round trip", () => {
  it("local → remote → local keeps the stack, flips install.json only after verification", async () => {
    const t = machine();
    const up = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(up).toEqual({ ok: true, changed: true });
    expect(t.m.backend).toEqual(GCS);
    expect(t.m.backups).toBe(1);
    expect(t.p.stacks.get(t.gcsUrl)?.secretsProvider).toBe(
      "gcpkms://projects/acme/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state",
    );
    expect(t.m.retired).toEqual([`${ROOT}/state.migrated-x`]);
    expect(t.p.calls[0]).toContain("migrate file://");

    const down = await migrateState(t.meta(), { to: "local", dryRun: false }, t.deps);
    expect(down).toEqual({ ok: true, changed: true });
    expect(t.m.backend).toEqual({ kind: "local" });
    const back = t.p.stacks.get(t.localUrl);
    expect(back?.secretsProvider).toBe("passphrase");
    expect(back?.outputs.bootstrapUrlOut).toBe("https://x/setup?token=s3cret");
    // No secret ends up in the progress output.
    expect(t.report.lines.join("\n")).not.toContain("s3cret");
  });

  it("is idempotent: migrating to where the state already is changes nothing", async () => {
    const t = machine(GCS);
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r).toEqual({ ok: true, changed: false });
    expect(t.m.backups).toBe(0);
    expect(t.p.calls).toEqual([]);
  });

  it("uses export/import on a Pulumi CLI older than 3.254.0", async () => {
    const t = machine();
    t.deps.pulumi.cliVersion = async () => "3.234.0";
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(true);
    expect(t.p.calls.some((c) => c.startsWith("export-import"))).toBe(true);
  });

  it("removes a leftover copy from an interrupted run before copying", async () => {
    const t = machine();
    t.p.stacks.set(t.gcsUrl, {
      outputs: { stale: true },
      secretsProvider: "x",
      pending: 0,
      drift: 0,
    });
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(true);
    expect(t.p.calls[0]).toBe(`rm ${t.gcsUrl}`);
    expect(t.p.stacks.get(t.gcsUrl)?.outputs.stale).toBeUndefined();
  });
});

describe("migrateState — failures leave the source authoritative", () => {
  it("an outputs mismatch discards the copy and never flips install.json", async () => {
    const t = machine();
    t.p.faults.corruptCopy = true;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("outputs differ");
    expect(r.error).toContain("stays authoritative");
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.p.stacks.has(t.gcsUrl)).toBe(false);
    expect(t.p.stacks.has(t.localUrl)).toBe(true);
    expect(t.m.retired).toEqual([]);
  });

  it("a source updated by another run during the copy aborts before the switch", async () => {
    const t = machine();
    let reads = 0;
    t.p.faults.onStateDigest = () => {
      reads++;
      // Second read (just before the switch): an installer run elsewhere wrote the source.
      if (reads === 2) {
        const src = t.p.stacks.get(t.localUrl);
        if (src) src.outputs = { ...src.outputs, extra: 1 };
      }
    };
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("changed during the migration");
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.p.stacks.has(t.gcsUrl)).toBe(false);
  });

  it("refuses while a Pulumi run holds the source stack's lock", async () => {
    const t = machine();
    t.p.faults.lockedUrl = t.localUrl;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("updating this stack right now");
    expect(t.m.backups).toBe(0);
  });

  it("a copy whose preview shows changes is discarded", async () => {
    const t = machine();
    t.p.faults.driftOnTarget = 2;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    expect(t.report.lines.join("\n")).toContain("The copy's preview plans:");
    expect(t.m.planFiles).toEqual([{ label: "state-migrate-copy", steps: 2 }]);
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.p.stacks.has(t.gcsUrl)).toBe(false);
  });

  it("a failed copy changes nothing", async () => {
    const t = machine();
    t.p.faults.copyFails = true;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.p.stacks.has(t.localUrl)).toBe(true);
  });

  it("refuses an unconverged stack with 'run upgrade first', before any backup", async () => {
    const t = machine();
    const local = t.p.stacks.get(t.localUrl);
    if (local) local.drift = 3;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Run upgrade first");
    expect(t.m.backups).toBe(0);
    expect(t.m.ensureRemoteCalls).toEqual([]);
  });

  it("the refusal lists every planned step, replaces and data loss first, and writes the diff (#737)", async () => {
    const t = machine();
    const local = t.p.stacks.get(t.localUrl);
    if (local) {
      local.plan = [
        ...updates(1),
        {
          op: "replace",
          type: "gcp:sql/databaseInstance:DatabaseInstance",
          name: "caelo-production-pg",
          urn: "urn:pulumi:production::caelo-gcp-firebase::gcp:sql/databaseInstance:DatabaseInstance::caelo-production-pg",
          diffs: ["region", "settings"],
          replaceReasons: ["region"],
        },
      ];
    }
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("a preview shows 2 change(s)");
    expect(r.error).toContain(
      "gcp:sql/databaseInstance:DatabaseInstance caelo-production-pg (replaced because region changes)  <-- LOSES DATA: Cloud SQL instance",
    );
    expect(r.error).toContain("gcp:projects/iAMMember:IAMMember binding-0 (member)");
    expect(r.error.indexOf("REPLACES")).toBeLessThan(r.error.indexOf("Updates in place"));
    expect(r.error).toContain(`Full diff: ${ROOT}/plan-state-migrate.txt`);
    expect(t.m.planFiles).toEqual([{ label: "state-migrate", steps: 2 }]);
    expect(t.m.backups).toBe(0);
  });

  it("the refusal names the planned creates the installer adopts (#1079)", async () => {
    const t = machine();
    const local = t.p.stacks.get(t.localUrl);
    if (local) local.drift = 2;
    t.m.existing = ["service account caelo-production-gateway-sa@acme.iam.gserviceaccount.com"];
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(
      "1 of the planned creates exist in the project already (service account caelo-production-gateway-sa@acme.iam.gserviceaccount.com): upgrade made them without Pulumi. The installer adopts them into the stack first",
    );
    expect(r.error.indexOf("adopts them")).toBeLessThan(r.error.indexOf("Run upgrade first"));
  });

  it("the refusal says nothing about adopting when nothing exists, and says so when it can't check", async () => {
    const t = machine();
    const local = t.p.stacks.get(t.localUrl);
    if (local) local.drift = 1;
    const none = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.error).not.toContain("adopt");
    t.m.existing = new Error("gcloud: PERMISSION_DENIED");
    const failed = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toContain(
      "(Could not check which planned creates exist in the project already: gcloud: PERMISSION_DENIED. The installer checks again.)",
    );
    expect(failed.error).toContain("Run upgrade first");
  });

  it("refuses a stack with pending operations", async () => {
    const t = machine();
    const local = t.p.stacks.get(t.localUrl);
    if (local) local.pending = 1;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("pending operation");
    expect(t.p.calls).toEqual([]);
  });

  it("--to local refuses when another machine already moved the state off the bucket", async () => {
    const t = machine(GCS);
    t.p.stacks.delete(t.localUrl);
    t.p.stacks.set(t.gcsUrl, { outputs: { a: 1 }, secretsProvider: "kms", pending: 0, drift: 0 });
    t.m.bucketRecord = "local";
    const r = await migrateState(t.meta(), { to: "local", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    expect(t.p.calls).toEqual([]);
    expect(t.m.backend).toEqual(GCS);
  });

  it("never replaces a bucket copy another machine made authoritative", async () => {
    const t = machine();
    t.m.bucketRecord = "gcs";
    t.p.stacks.set(t.gcsUrl, {
      outputs: { newer: true },
      secretsProvider: "kms",
      pending: 0,
      drift: 0,
    });
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("attach --project acme");
    expect(t.p.stacks.get(t.gcsUrl)?.outputs.newer).toBe(true);
    expect(t.p.calls).toEqual([]);
    expect(t.m.backups).toBe(0);
  });

  it("self-hosted has nothing to migrate", async () => {
    const t = machine();
    const r = await migrateState(
      { ...t.meta(), provider: "self-hosted" },
      { to: "remote", dryRun: false },
      t.deps,
    );
    expect(r.ok).toBe(false);
  });
});

describe("migrateState — interrupted --to local resumes", () => {
  it("moves an unused local stack aside (kept) and copies again", async () => {
    const t = machine(GCS);
    const s = t.p.stacks.get(t.localUrl);
    if (s) t.p.stacks.set(t.gcsUrl, { ...s, secretsProvider: "kms" });
    // The local stack is the leftover of the interrupted run.
    const r = await migrateState(t.meta(), { to: "local", dryRun: false }, t.deps);
    expect(r).toEqual({ ok: true, changed: true });
    expect(t.m.retired).toEqual([`${ROOT}/state.migrated-x`]);
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.p.stacks.get(t.localUrl)?.secretsProvider).toBe("passphrase");
  });
});

describe("migrateState — one migration at a time", () => {
  it("refuses while another migration holds the lock, and releases its own", async () => {
    const t = machine();
    t.m.locked = true;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.p.calls).toEqual([]);
    t.m.locked = false;
    expect((await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps)).ok).toBe(true);
    expect(t.m.locked).toBe(false);
  });

  it("re-checks authority under the lock: a run that lost the race removes nothing", async () => {
    const t = machine();
    // The other machine finishes between this run's preflight and its lock.
    t.deps.lock = async () => {
      t.m.bucketRecord = "gcs";
      t.p.stacks.set(t.gcsUrl, {
        outputs: { theirs: true },
        secretsProvider: "kms",
        pending: 0,
        drift: 0,
      });
      return async () => {};
    };
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    expect(t.p.stacks.get(t.gcsUrl)?.outputs.theirs).toBe(true);
    expect(t.p.calls).toEqual([]);
  });
});

describe("migrateState — cost confirmation (CLAUDE.md §11.C)", () => {
  it("creates nothing billable when the operator declines", async () => {
    const t = machine();
    t.m.acceptCost = false;
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r.ok).toBe(false);
    expect(t.m.ensureRemoteCalls).toEqual([]);
    expect(t.m.backend).toEqual({ kind: "local" });
  });
});

describe("migrateState — dry run", () => {
  it("reads, reports the plan and changes nothing", async () => {
    const t = machine();
    const r = await migrateState(t.meta(), { to: "remote", dryRun: true }, t.deps);
    expect(r).toEqual({ ok: true, changed: false });
    expect(t.m.backend).toEqual({ kind: "local" });
    expect(t.m.backups).toBe(0);
    expect(t.m.ensureRemoteCalls).toEqual([true]);
    expect(t.p.calls).toEqual([]);
    expect(t.p.stacks.has(t.gcsUrl)).toBe(false);
    const out = t.report.lines.join("\n");
    expect(out).toContain("Dry run — nothing changed");
    expect(out).toContain("would create gs://acme-caelo-ops");
    // #737 — the preview's list even when it would migrate.
    expect(out).toContain("The preview plans no changes.");
    expect(t.m.planFiles).toEqual([{ label: "state-migrate-dry-run", steps: 0 }]);
  });
});

describe("helpers", () => {
  it("versionAtLeast", () => {
    expect(versionAtLeast("3.254.0", "3.254.0")).toBe(true);
    expect(versionAtLeast("v3.260.1", "3.254.0")).toBe(true);
    expect(versionAtLeast("3.234.0", "3.254.0")).toBe(false);
    expect(versionAtLeast("4.0.0", "3.254.0")).toBe(true);
  });

  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });

  it("upgrade's notice points a local GCP install at state migrate, dry run first", () => {
    const n = localStateNotice({ installId: "gcp-firebase-viu-one", provider: "gcp-firebase" });
    expect(n).toContain("state migrate --install gcp-firebase-viu-one --dry-run");
    expect(localStateNotice({ installId: "x", provider: "gcp", stateBackend: GCS })).toBeNull();
    expect(localStateNotice({ installId: "x", provider: "self-hosted" })).toBeNull();
  });
});

describe("migrateState — Application Default Credentials (#1078)", () => {
  /** A Pulumi workspace that fails the test on any call. */
  const untouchable = (): StatePulumiOps =>
    new Proxy({} as StatePulumiOps, {
      get: (_t, name) => () => {
        throw new Error(`Pulumi ${String(name)} must not run without working ADC`);
      },
    });

  for (const [what, error] of [
    [
      "missing",
      "No Application Default Credentials on this machine; Pulumi needs them. Run `gcloud auth application-default login` and re-run this command.",
    ],
    [
      "expired",
      "The Application Default Credentials on this machine have expired (gcloud: invalid_grant: reauth related error (invalid_rapt)). Run `gcloud auth application-default login` and re-run this command.",
    ],
  ] as const) {
    for (const dryRun of [false, true]) {
      it(`${what} ADC stop the run before any Pulumi call${dryRun ? " (dry run)" : ""}`, async () => {
        const t = machine();
        t.m.adc = { ok: false, error };
        const r = await migrateState(
          t.meta(),
          { to: "remote", dryRun },
          { ...t.deps, pulumi: untouchable() },
        );
        expect(r).toEqual({ ok: false, error: `${error} Nothing was changed.` });
        expect(t.m.adcChecks).toBe(1);
        expect(t.m.backend).toEqual({ kind: "local" });
        expect(t.m.backups).toBe(0);
        expect(t.m.ensureRemoteCalls).toEqual([]);
        expect(t.m.locked).toBe(false);
      });
    }
  }

  it("working ADC let the migration run", async () => {
    const t = machine();
    const r = await migrateState(t.meta(), { to: "remote", dryRun: false }, t.deps);
    expect(r).toEqual({ ok: true, changed: true });
    expect(t.m.adcChecks).toBe(1);
  });
});
