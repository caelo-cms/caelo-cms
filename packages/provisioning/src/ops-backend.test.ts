// SPDX-License-Identifier: MPL-2.0

/**
 * The install's ops bucket + Pulumi state key (#696, ops-backend.ts) against
 * a stateful fake gcloud. Load-bearing: a fresh project ends with a
 * versioned, uniform-access, public-access-prevented bucket and a KMS key
 * that only the operator and caelo-provisioner may use; a second run writes
 * nothing; a public bucket is refused; a dry run only reads; nothing is
 * ever deleted.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import {
  ensureOpsBackend,
  NONCURRENT_VERSION_DAYS,
  OPS_BUCKET_ROLE,
  OPS_KEY_ROLE,
} from "./ops-backend.js";
import { opsKmsKeyName } from "./state-backend.js";
import { estimateGcpCost } from "./wizards/gcp-cost.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

type Binding = { role: string; members: string[] };

/** A tiny in-memory GCP: one bucket, one key ring, one key, their policies. */
function fakeGcp(initial: { bucket?: boolean; ring?: boolean; key?: boolean } = {}) {
  const state = {
    apis: new Set<string>(),
    bucket: initial.bucket
      ? {
          versioning_enabled: true,
          uniform_bucket_level_access: true,
          public_access_prevention: "enforced",
          lifecycle_config: { rule: [{ condition: { daysSinceNoncurrentTime: 30 } }] },
        }
      : null,
    bucketPolicy: [] as Binding[],
    ring: initial.ring ?? false,
    key: initial.key ?? false,
    keyPolicy: [] as Binding[],
  };
  const calls: string[] = [];
  const flag = (args: string[], name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const bind = (policy: Binding[], role: string, member: string) => {
    const b = policy.find((x) => x.role === role);
    if (b) {
      if (!b.members.includes(member)) b.members.push(member);
    } else policy.push({ role, members: [member] });
  };
  const run = async (args: string[]): Promise<GcloudResult> => {
    const line = args.join(" ");
    calls.push(line);
    if (line.startsWith("services enable")) {
      for (const a of args.slice(2)) if (!a.startsWith("--")) state.apis.add(a);
      return ok();
    }
    if (line.startsWith("storage buckets describe")) {
      return state.bucket ? ok(JSON.stringify(state.bucket)) : fail("ERROR: NotFound: 404 bucket");
    }
    if (line.startsWith("storage buckets create")) {
      state.bucket = {
        versioning_enabled: false,
        uniform_bucket_level_access: args.includes("--uniform-bucket-level-access"),
        public_access_prevention: args.includes("--public-access-prevention")
          ? "enforced"
          : "inherited",
        lifecycle_config: null as never,
      };
      // GCS adds the convenience bindings to every new bucket.
      state.bucketPolicy.push(
        {
          role: "roles/storage.legacyBucketOwner",
          members: ["projectOwner:acme", "projectEditor:acme"],
        },
        { role: "roles/storage.legacyBucketReader", members: ["projectViewer:acme"] },
      );
      return ok();
    }
    if (line.startsWith("storage buckets update")) {
      if (!state.bucket) return fail("NotFound");
      if (args.includes("--versioning")) state.bucket.versioning_enabled = true;
      if (args.includes("--uniform-bucket-level-access"))
        state.bucket.uniform_bucket_level_access = true;
      if (args.includes("--public-access-prevention"))
        state.bucket.public_access_prevention = "enforced";
      if (flag(args, "lifecycle-file")) {
        state.bucket.lifecycle_config = {
          rule: [{ condition: { daysSinceNoncurrentTime: NONCURRENT_VERSION_DAYS } }],
        } as never;
      }
      return ok();
    }
    if (line.startsWith("storage buckets get-iam-policy")) {
      return ok(JSON.stringify({ bindings: state.bucketPolicy }));
    }
    if (line.startsWith("storage buckets add-iam-policy-binding")) {
      bind(state.bucketPolicy, flag(args, "role") ?? "", flag(args, "member") ?? "");
      return ok();
    }
    if (line.startsWith("storage buckets remove-iam-policy-binding")) {
      const b = state.bucketPolicy.find((x) => x.role === flag(args, "role"));
      if (b) b.members = b.members.filter((m) => m !== flag(args, "member"));
      return ok();
    }
    if (line.startsWith("kms keyrings describe")) {
      return state.ring
        ? ok("projects/acme/locations/europe-west1/keyRings/caelo")
        : fail("NOT_FOUND: KeyRing");
    }
    if (line.startsWith("kms keyrings create")) {
      state.ring = true;
      return ok();
    }
    if (line.startsWith("kms keys describe")) {
      return state.key ? ok(opsKmsKeyName("acme", "europe-west1")) : fail("NOT_FOUND: CryptoKey");
    }
    if (line.startsWith("kms keys create")) {
      state.key = true;
      return ok();
    }
    if (line.startsWith("kms keys get-iam-policy")) {
      return ok(JSON.stringify({ bindings: state.keyPolicy }));
    }
    if (line.startsWith("kms keys add-iam-policy-binding")) {
      bind(state.keyPolicy, flag(args, "role") ?? "", flag(args, "member") ?? "");
      return ok();
    }
    return fail(`unexpected gcloud ${line}`);
  };
  const writes = () =>
    calls.filter(
      (c) => !/ (describe|get-iam-policy) /.test(` ${c} `) && !c.startsWith("services enable"),
    );
  return { run, calls, state, writes };
}

const TARGET = {
  projectId: "acme",
  region: "europe-west1",
  operatorAccount: "Owner@Example.com",
  provisionerEmail: "caelo-provisioner@acme.iam.gserviceaccount.com",
};
const OPERATOR = "user:owner@example.com";
const PROVISIONER = "serviceAccount:caelo-provisioner@acme.iam.gserviceaccount.com";
const noSleep = async () => {};

describe("ensureOpsBackend — new install", () => {
  it("creates a hardened bucket + KMS key that only the operator and the provisioner can use", async () => {
    const g = fakeGcp();
    const r = await ensureOpsBackend(TARGET, { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toEqual({
      kind: "gcs",
      bucket: "acme-caelo-ops",
      kmsKey: "projects/acme/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state",
    });
    expect(g.state.apis.has("cloudkms.googleapis.com")).toBe(true);
    expect(g.state.bucket).toMatchObject({
      versioning_enabled: true,
      uniform_bucket_level_access: true,
      public_access_prevention: "enforced",
    });
    expect(
      g.calls.some((c) => c.includes("--location=europe-west1") && c.includes("buckets create")),
    ).toBe(true);
    // Bucket: exactly the operator + the provisioner hold object access; the
    // viewer/editor convenience bindings are gone; nothing public.
    const objectAdmins = g.state.bucketPolicy.find((b) => b.role === OPS_BUCKET_ROLE)?.members;
    expect(objectAdmins?.sort()).toEqual([PROVISIONER, OPERATOR].sort());
    const everyone = g.state.bucketPolicy.flatMap((b) => b.members);
    expect(everyone.some((m) => /^project(Viewer|Editor):/.test(m))).toBe(false);
    expect(everyone.some((m) => m === "allUsers" || m === "allAuthenticatedUsers")).toBe(false);
    // Key: the same two principals, encrypt/decrypt only.
    expect(g.state.ring && g.state.key).toBe(true);
    expect(g.state.keyPolicy).toEqual([{ role: OPS_KEY_ROLE, members: [OPERATOR, PROVISIONER] }]);
    // Never deletes anything.
    expect(g.calls.some((c) => / delete /.test(` ${c} `))).toBe(false);
  });

  it("is idempotent: a second run reads and writes nothing", async () => {
    const g = fakeGcp();
    await ensureOpsBackend(TARGET, { run: g.run, sleep: noSleep });
    const before = g.writes().length;
    const again = await ensureOpsBackend(TARGET, { run: g.run, sleep: noSleep });
    expect(again.ok && again.actions).toEqual([]);
    expect(g.writes().length).toBe(before);
  });

  it("brings an existing bucket that lost its hardening back in line", async () => {
    const g = fakeGcp({ bucket: true, ring: true, key: true });
    if (g.state.bucket) {
      g.state.bucket.versioning_enabled = false;
      g.state.bucket.public_access_prevention = "inherited";
    }
    const r = await ensureOpsBackend(TARGET, { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(g.state.bucket).toMatchObject({
      versioning_enabled: true,
      public_access_prevention: "enforced",
    });
    expect(g.calls.some((c) => c.startsWith("storage buckets create"))).toBe(false);
    expect(g.calls.some((c) => c.startsWith("kms keys create"))).toBe(false);
  });

  it("refuses a bucket that grants public access, naming the binding", async () => {
    const g = fakeGcp({ bucket: true, ring: true, key: true });
    g.state.bucketPolicy.push({ role: "roles/storage.objectViewer", members: ["allUsers"] });
    const r = await ensureOpsBackend(TARGET, { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("allUsers (roles/storage.objectViewer)");
    expect(r.error).toContain("must never be public");
  });

  it("stops on a bucket name it cannot read (taken by another project)", async () => {
    const g = fakeGcp();
    const run = async (args: string[]) =>
      args.join(" ").startsWith("storage buckets describe")
        ? fail("ERROR: 403 caller does not have storage.buckets.get access")
        : g.run(args);
    const r = await ensureOpsBackend(TARGET, { run, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(g.calls.some((c) => c.startsWith("storage buckets create"))).toBe(false);
  });

  it("dry run lists what it would do and writes nothing", async () => {
    const g = fakeGcp();
    const r = await ensureOpsBackend(TARGET, { run: g.run, sleep: noSleep, dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions.every((a) => a.startsWith("would "))).toBe(true);
    expect(r.actions.join("\n")).toContain("would create gs://acme-caelo-ops in europe-west1");
    expect(r.actions.join("\n")).toContain("would create KMS key caelo/pulumi-state");
    expect(g.writes()).toEqual([]);
    expect(g.calls.some((c) => c.startsWith("services enable"))).toBe(false);
  });
});

describe("cost table (CLAUDE.md §11.C)", () => {
  it("lists the state bucket + KMS key at under $0.10/mo without float noise in the total", () => {
    const est = estimateGcpCost({
      cloudSqlTier: "db-f1-micro",
      cloudSqlHa: false,
      adminMinInstances: 0,
      gatewayMinInstances: 0,
      wafAdaptiveProtection: false,
      provider: "gcp-firebase",
      region: "europe-west1",
    });
    const line = est.lines.find((l) => l.name.includes("ops bucket"));
    expect(line?.monthlyUsd).toBeLessThan(0.1);
    expect(line?.notes).toContain("< $0.10/mo");
    expect(String(est.totalUsd)).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});
