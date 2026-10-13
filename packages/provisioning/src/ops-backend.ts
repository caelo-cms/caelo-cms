// SPDX-License-Identifier: MPL-2.0

/**
 * The install's ops bucket + Pulumi state key in its own GCP project (#696,
 * D2). Ensured by the GCP wizard for every new install (before the cost
 * confirmation — both are near-free, see gcp-cost.ts) and by
 * the state migration for an existing one.
 *
 *   - `gs://<project>-caelo-ops`, in the install region: object versioning
 *     on (every Pulumi checkpoint write is recoverable), uniform bucket-level
 *     access (no per-object ACLs), public access prevention enforced, and a
 *     lifecycle rule that deletes non-current versions after
 *     {@link NONCURRENT_VERSION_DAYS} days — Pulumi rewrites its checkpoint on
 *     every resource step, so unbounded versions would grow without end.
 *   - Cloud KMS key ring `caelo`, key `pulumi-state` (symmetric, software
 *     protection, no automatic rotation: each rotation adds a billed key
 *     version, and the key only wraps Pulumi's data key).
 *   - IAM: the operator and `caelo-provisioner` get object access on the
 *     bucket and encrypt/decrypt on the key — nobody else is granted
 *     anything. The bucket's convenience bindings for project viewers and
 *     editors are removed; public principals are refused outright. Project
 *     Owners keep access through their project role (that cannot be taken
 *     away at the bucket); docs-site/pages/install-gcp.md says so.
 *
 * Every step reads before it writes, so a re-run is a no-op and an operator
 * without IAM-write permission can still run against an ops backend someone
 * else ensured. Nothing here ever deletes a bucket, an object or a key.
 */

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { operatorMember } from "./provisioner-identity.js";
import {
  gcsBackendRecord,
  OPS_KEY_RING,
  OPS_STATE_KEY,
  opsBucketName,
  type StateBackendRecord,
} from "./state-backend.js";

/** Days a superseded Pulumi checkpoint version stays recoverable. */
export const NONCURRENT_VERSION_DAYS = 30;

/** Role the operator + provisioner hold on the ops bucket. */
export const OPS_BUCKET_ROLE = "roles/storage.objectAdmin";
/** Role the operator + provisioner hold on the state key. */
export const OPS_KEY_ROLE = "roles/cloudkms.cryptoKeyEncrypterDecrypter";

/** Principals that must never appear on the ops bucket. */
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);

/** gcloud's wording for a resource that does not exist (yet). */
const NOT_FOUND = /NOT_FOUND|NotFound|not found|404|does not exist/i;

/** Everything {@link ensureOpsBackend} needs to know about the install. */
export interface OpsBackendTarget {
  readonly projectId: string;
  /** The install region; bucket and key ring live here. */
  readonly region: string;
  /** The gcloud account running the command (gets access). */
  readonly operatorAccount: string;
  /** `caelo-provisioner@<project>.iam.gserviceaccount.com` (gets access). */
  readonly provisionerEmail: string;
}

export type OpsBackendResult =
  | {
      readonly ok: true;
      readonly record: StateBackendRecord;
      /** What was done (or, with `dryRun`, would be done); empty when all was in place. */
      readonly actions: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

interface BucketDescription {
  versioning_enabled?: boolean;
  uniform_bucket_level_access?: boolean;
  public_access_prevention?: string;
  lifecycle_config?: unknown;
}

interface IamPolicy {
  bindings?: { role?: string; members?: string[]; condition?: unknown }[];
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return (JSON.parse(text || "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The lifecycle rule the ops bucket carries — and no other. */
const OPS_LIFECYCLE_RULE = {
  action: { type: "Delete" },
  condition: { daysSinceNoncurrentTime: NONCURRENT_VERSION_DAYS, isLive: false },
} as const;

/**
 * Whether a bucket's lifecycle is exactly {@link OPS_LIFECYCLE_RULE}. Any
 * other rule — a shorter window, a prefix filter, a rule deleting live
 * objects — could cut the recovery window or delete the state itself, so
 * it is replaced, not tolerated.
 */
export function isOpsLifecycle(config: unknown): boolean {
  const rules = (config as { rule?: unknown } | null | undefined)?.rule;
  if (!Array.isArray(rules) || rules.length !== 1) return false;
  const r = rules[0] as { action?: Record<string, unknown>; condition?: Record<string, unknown> };
  const cond = r.condition ?? {};
  return (
    r.action?.type === "Delete" &&
    Object.keys(r.action).length === 1 &&
    cond.daysSinceNoncurrentTime === NONCURRENT_VERSION_DAYS &&
    cond.isLive === false &&
    Object.keys(cond).length === 2
  );
}

const hasBinding = (policy: IamPolicy, role: string, member: string): boolean =>
  (policy.bindings ?? []).some(
    (b) =>
      b.role === role &&
      b.condition == null &&
      (b.members ?? []).some((m) => m.toLowerCase() === member.toLowerCase()),
  );

const reason = (stderr: string, exitCode: number) =>
  stderr.trim().split("\n").slice(-3).join(" ") || `gcloud exited ${exitCode}`;

/**
 * Ensure the ops bucket + state key exist with the settings and IAM above.
 * Idempotent; never throws for a gcloud failure (the result says what
 * failed and what to run). With `dryRun` it only reads and reports what it
 * would change.
 */
export async function ensureOpsBackend(
  target: OpsBackendTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep; dryRun?: boolean } = {},
): Promise<OpsBackendResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const dryRun = deps.dryRun ?? false;
  const { projectId, region } = target;
  const project = `--project=${projectId}`;
  const bucket = opsBucketName(projectId);
  const bucketUrl = `gs://${bucket}`;
  const members = [
    operatorMember(target.operatorAccount),
    `serviceAccount:${target.provisionerEmail}`,
  ];
  const actions: string[] = [];
  const act = (what: string) => actions.push(dryRun ? `would ${what}` : what);
  const fail = (what: string, r: { stderr: string; exitCode: number }): OpsBackendResult => ({
    ok: false,
    error: `${what} failed: ${reason(r.stderr, r.exitCode)}`,
  });

  // --- APIs -------------------------------------------------------------
  if (!dryRun) {
    const apis = await run([
      "services",
      "enable",
      "cloudkms.googleapis.com",
      "storage.googleapis.com",
      project,
    ]);
    if (!apis.ok) return fail("Enabling the Cloud KMS API", apis);
  }

  // --- Bucket -----------------------------------------------------------
  const described = await run([
    "storage",
    "buckets",
    "describe",
    bucketUrl,
    project,
    "--format=json",
  ]);
  let bucketExists = described.ok;
  if (!described.ok && !NOT_FOUND.test(described.stderr)) {
    return {
      ok: false,
      error: `Could not read ${bucketUrl}: ${reason(described.stderr, described.exitCode)}. If the name is taken by a bucket outside project ${projectId}, the install can't use it — tell the maintainers (the name is <project>-caelo-ops).`,
    };
  }
  if (bucketExists) {
    // Bucket names are global and `--project` does not scope `describe`: a
    // bucket of that name in a project the operator can also reach would
    // otherwise receive this install's state.
    const owned = await run(["storage", "buckets", "list", project, "--format=value(name)"]);
    if (!owned.ok) return fail(`Listing the buckets of project ${projectId}`, owned);
    const names = owned.stdout.split("\n").map((l) =>
      l
        .trim()
        .replace(/^gs:\/\//, "")
        .replace(/\/$/, ""),
    );
    if (!names.includes(bucket)) {
      return {
        ok: false,
        error: `${bucketUrl} exists but does not belong to project ${projectId}. The install's state must live in its own project; delete or rename that bucket, or tell the maintainers (the name is <project>-caelo-ops).`,
      };
    }
  }
  if (!bucketExists) {
    act(`create ${bucketUrl} in ${region}`);
    if (!dryRun) {
      const created = await run([
        "storage",
        "buckets",
        "create",
        bucketUrl,
        project,
        `--location=${region}`,
        "--default-storage-class=STANDARD",
        "--uniform-bucket-level-access",
        "--public-access-prevention",
      ]);
      if (!created.ok) return fail(`Creating ${bucketUrl}`, created);
      bucketExists = true;
    }
  }
  const desc: BucketDescription = described.ok ? parseJson(described.stdout, {}) : {};
  // A bucket created above already has uniform access + public access
  // prevention; `buckets create` has no versioning flag.
  const updates: string[] = [];
  if (desc.versioning_enabled !== true) updates.push("--versioning");
  if (described.ok && desc.uniform_bucket_level_access !== true) {
    updates.push("--uniform-bucket-level-access");
  }
  if (described.ok && desc.public_access_prevention !== "enforced") {
    updates.push("--public-access-prevention");
  }
  const hasLifecycle = isOpsLifecycle(desc.lifecycle_config);
  if (updates.length > 0) {
    act(`set ${updates.map((u) => u.slice(2)).join(", ")} on ${bucketUrl}`);
    if (!dryRun) {
      const r = await run(["storage", "buckets", "update", bucketUrl, project, ...updates]);
      if (!r.ok) return fail(`Updating ${bucketUrl}`, r);
    }
  }
  if (!hasLifecycle) {
    act(
      `set the lifecycle of ${bucketUrl} to: delete non-current object versions after ${NONCURRENT_VERSION_DAYS} days (nothing else)`,
    );
    if (!dryRun) {
      const file = join(tmpdir(), `caelo-ops-lifecycle-${process.pid}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          rule: [OPS_LIFECYCLE_RULE],
        }),
      );
      try {
        const r = await run([
          "storage",
          "buckets",
          "update",
          bucketUrl,
          project,
          `--lifecycle-file=${file}`,
        ]);
        if (!r.ok) return fail(`Setting the lifecycle rule on ${bucketUrl}`, r);
      } finally {
        rmSync(file, { force: true });
      }
    }
  }

  // --- Bucket IAM -------------------------------------------------------
  if (bucketExists) {
    const got = await run([
      "storage",
      "buckets",
      "get-iam-policy",
      bucketUrl,
      project,
      "--format=json",
    ]);
    if (!got.ok) return fail(`Reading the IAM policy of ${bucketUrl}`, got);
    const policy = parseJson<IamPolicy>(got.stdout, {});
    const exposed = (policy.bindings ?? []).flatMap((b) =>
      (b.members ?? []).filter((m) => PUBLIC_MEMBERS.has(m)).map((m) => `${m} (${b.role})`),
    );
    if (exposed.length > 0) {
      return {
        ok: false,
        error: `${bucketUrl} grants ${exposed.join(", ")}. It holds the install's infrastructure state and must never be public. Remove those bindings (gcloud storage buckets remove-iam-policy-binding ${bucketUrl} --member=<member> --role=<role>) and re-run.`,
      };
    }
    for (const member of members) {
      if (hasBinding(policy, OPS_BUCKET_ROLE, member)) continue;
      act(`grant ${member} ${OPS_BUCKET_ROLE} on ${bucketUrl}`);
      if (dryRun) continue;
      const r = await runWithRetry(run, sleep, [
        "storage",
        "buckets",
        "add-iam-policy-binding",
        bucketUrl,
        project,
        `--member=${member}`,
        `--role=${OPS_BUCKET_ROLE}`,
      ]);
      if (!r.ok) return fail(`Granting ${member} access to ${bucketUrl}`, r);
    }
    for (const b of policy.bindings ?? []) {
      for (const m of b.members ?? []) {
        if (!/^project(Viewer|Editor):/.test(m) || !b.role) continue;
        act(`remove ${m} ${b.role} from ${bucketUrl}`);
        if (dryRun) continue;
        const r = await run([
          "storage",
          "buckets",
          "remove-iam-policy-binding",
          bucketUrl,
          project,
          `--member=${m}`,
          `--role=${b.role}`,
        ]);
        if (!r.ok) return fail(`Removing ${m} from ${bucketUrl}`, r);
      }
    }
  } else {
    for (const member of members) act(`grant ${member} ${OPS_BUCKET_ROLE} on ${bucketUrl}`);
  }

  // --- KMS key ring + key -------------------------------------------------
  const kmsWhere = [`--location=${region}`, project];
  const ring = await run([
    "kms",
    "keyrings",
    "describe",
    OPS_KEY_RING,
    ...kmsWhere,
    "--format=value(name)",
  ]);
  // In a dry run the KMS API may still be disabled; that reads as "not there yet".
  const ringMissing = !ring.ok && (NOT_FOUND.test(ring.stderr) || dryRun);
  if (!ring.ok && !ringMissing) return fail(`Reading key ring ${OPS_KEY_RING}`, ring);
  if (ringMissing) {
    act(`create KMS key ring ${OPS_KEY_RING} in ${region}`);
    if (!dryRun) {
      const r = await run(["kms", "keyrings", "create", OPS_KEY_RING, ...kmsWhere]);
      if (!r.ok) return fail(`Creating key ring ${OPS_KEY_RING}`, r);
    }
  }
  const keyWhere = [`--keyring=${OPS_KEY_RING}`, ...kmsWhere];
  const key = ringMissing
    ? { ok: false, stderr: "NOT_FOUND", stdout: "", exitCode: 1 }
    : await run(["kms", "keys", "describe", OPS_STATE_KEY, ...keyWhere, "--format=value(name)"]);
  const keyMissing = !key.ok && NOT_FOUND.test(key.stderr);
  if (!key.ok && !keyMissing) return fail(`Reading key ${OPS_STATE_KEY}`, key);
  if (keyMissing) {
    act(`create KMS key ${OPS_KEY_RING}/${OPS_STATE_KEY}`);
    if (!dryRun) {
      const r = await run([
        "kms",
        "keys",
        "create",
        OPS_STATE_KEY,
        ...keyWhere,
        "--purpose=encryption",
        "--protection-level=software",
      ]);
      if (!r.ok) return fail(`Creating key ${OPS_STATE_KEY}`, r);
    }
  }

  // --- Key IAM ------------------------------------------------------------
  let keyPolicy: IamPolicy = {};
  if (!keyMissing) {
    const got = await run([
      "kms",
      "keys",
      "get-iam-policy",
      OPS_STATE_KEY,
      ...keyWhere,
      "--format=json",
    ]);
    if (!got.ok) return fail(`Reading the IAM policy of key ${OPS_STATE_KEY}`, got);
    keyPolicy = parseJson<IamPolicy>(got.stdout, {});
  }
  for (const member of members) {
    if (hasBinding(keyPolicy, OPS_KEY_ROLE, member)) continue;
    act(`grant ${member} ${OPS_KEY_ROLE} on ${OPS_KEY_RING}/${OPS_STATE_KEY}`);
    if (dryRun) continue;
    const r = await runWithRetry(run, sleep, [
      "kms",
      "keys",
      "add-iam-policy-binding",
      OPS_STATE_KEY,
      ...keyWhere,
      `--member=${member}`,
      `--role=${OPS_KEY_ROLE}`,
    ]);
    if (!r.ok) return fail(`Granting ${member} use of key ${OPS_STATE_KEY}`, r);
  }

  return { ok: true, record: gcsBackendRecord(projectId, region), actions };
}
