// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R2 #1648, R3 #1649) — the collection stores of a Google Cloud
 * install (`gcp`, `gcp-firebase`) and who may use them, plus the log
 * exclusion that keeps visitors' search queries out of the logs
 * (visitor-query-logs.ts).
 *
 * Plugin collections (a site search's pages, say) are built per Stage and
 * served by the gateways from object storage: never from a database, never
 * from the admin.
 *
 *   gs://<project>-caelo-<env>-coll-staging   change files the plugins
 *       write during a Stage (through the admin), the releases the
 *       collection index job builds from them; the staging gateway answers
 *       from here.
 *   gs://<project>-caelo-<env>-coll-live      what Publish live copied from
 *       staging before it moved the live pointer; the live gateway answers
 *       from here.
 *
 * Both private: uniform access, public access prevention enforced, no soft
 * delete (the admin deletes what no release keeps; a soft-deleted copy
 * would only be billed). Every file is content-named and written once.
 *
 * Grants ({@link COLLECTION_STORE_GRANTS}), each the least that works:
 *
 *   - the admin's run SA: objectAdmin on both — it writes change files,
 *     reads a plugin's document back for `ctx.collections.get`, copies a
 *     Stage's release files to live at Publish live, and deletes files no
 *     release keeps;
 *   - the live gateway's SA: objectViewer on the live store only;
 *   - the staging gateway's SA: objectViewer on the staging store only.
 *     Neither gateway can read the other environment's index (CLAUDE.md
 *     §2: staging content never reaches the live side), nor write any.
 *
 * The collection index job's own grants (read + create on the staging
 * store, nothing on live) are its reporting-job spec's
 * (reporting-job-setup.ts `collectionIndexJobSpec`).
 *
 * CLI-owned like the audit and capture buckets: `upgrade` never runs
 * Pulumi, so the wizard (after the first `pulumi up`) and every converge
 * run this, idempotently. Infrastructure contract 29.
 */

import { gcloud as defaultGcloud, isGcloudNotFound } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  gatewayServiceAccountEmail,
  gcpBucketName,
  gcpNamePrefix,
  runServiceAccountEmail,
  stagingGatewayServiceAccountEmail,
  visitorQueryLogExclusionName,
} from "./gcp-names.js";
import type { GcpProvider } from "./stack-contract.js";
import {
  DEFAULT_LOG_SINK,
  VISITOR_QUERY_LOG_DESCRIPTION,
  VISITOR_QUERY_LOG_FILTER,
} from "./visitor-query-logs.js";

/** Where the stores go. */
export interface CollectionStoresTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
}

/** What {@link ensureCollectionStores} did. */
export type CollectionStoresResult =
  | {
      readonly ok: true;
      readonly done: readonly string[];
      /** What it could not do yet, and when it will (never a failure of the install). */
      readonly pending: readonly string[];
    }
  | { readonly ok: false; readonly done: readonly string[]; readonly error: string };

/** Who a collection store grant is for. */
export type CollectionStoreReader = "admin" | "gateway" | "staging-gateway";

/** One bucket grant of the collection stores. */
export interface CollectionStoreGrant {
  readonly bucket: "coll-staging" | "coll-live";
  readonly member: CollectionStoreReader;
  readonly role: "roles/storage.objectAdmin" | "roles/storage.objectViewer";
  readonly why: string;
}

/** Every grant on the collection stores, but the index job's (see the file comment). */
export const COLLECTION_STORE_GRANTS: readonly CollectionStoreGrant[] = [
  {
    bucket: "coll-staging",
    member: "admin",
    role: "roles/storage.objectAdmin",
    why: "the admin writes the plugins' change files, reads documents back and deletes what no release keeps",
  },
  {
    bucket: "coll-live",
    member: "admin",
    role: "roles/storage.objectAdmin",
    why: "Publish live copies a Stage's releases from staging, and the admin deletes what no live release keeps",
  },
  {
    bucket: "coll-live",
    member: "gateway",
    role: "roles/storage.objectViewer",
    why: "the live gateway answers search, suggest and read from the live releases",
  },
  {
    bucket: "coll-staging",
    member: "staging-gateway",
    role: "roles/storage.objectViewer",
    why: "the staging gateway answers search, suggest and read from the Stage's releases",
  },
];

function memberEmail(t: CollectionStoresTarget, who: CollectionStoreReader): string {
  switch (who) {
    case "admin":
      return runServiceAccountEmail(t.projectId, t.env);
    case "gateway":
      return gatewayServiceAccountEmail(t.projectId, t.env);
    case "staging-gateway":
      return stagingGatewayServiceAccountEmail(t.projectId, t.env);
  }
}

const ALREADY_EXISTS = /ALREADY_EXISTS|already exists|409/i;

/**
 * Create both collection stores when missing and grant each reader its
 * access. Never throws for a gcloud failure. The staging gateway's grant
 * waits for its account when the install has none yet (its setup failed or
 * has not run): `pending` says so, and the next converge grants it.
 */
export async function ensureCollectionStores(
  target: CollectionStoresTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<CollectionStoresResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const project = `--project=${target.projectId}`;
  const done: string[] = [];
  const pending: string[] = [];

  for (const kind of ["coll-staging", "coll-live"] as const) {
    const url = `gs://${gcpBucketName(target.projectId, target.env, kind)}`;
    const described = await run([
      "storage",
      "buckets",
      "describe",
      url,
      project,
      "--format=value(name)",
    ]);
    if (described.ok) {
      done.push(`bucket ${url}`);
      continue;
    }
    if (!isGcloudNotFound(described.stderr)) {
      return { ok: false, done, error: `look up ${url}: ${described.stderr.trim()}` };
    }
    const created = await run([
      "storage",
      "buckets",
      "create",
      url,
      project,
      `--location=${target.region}`,
      "--default-storage-class=STANDARD",
      "--uniform-bucket-level-access",
      "--public-access-prevention",
      "--soft-delete-duration=0",
      "--quiet",
    ]);
    if (!created.ok) {
      return {
        ok: false,
        done,
        error: ALREADY_EXISTS.test(created.stderr)
          ? `${url} exists but does not belong to project ${target.projectId}; delete or rename that bucket, this install needs the name`
          : `create ${url}: ${created.stderr.trim()}`,
      };
    }
    done.push(`bucket ${url} (created: private, uniform access, no soft delete)`);
  }

  for (const g of COLLECTION_STORE_GRANTS) {
    const url = `gs://${gcpBucketName(target.projectId, target.env, g.bucket)}`;
    const email = memberEmail(target, g.member);
    if (g.member === "staging-gateway") {
      const exists = await run([
        "iam",
        "service-accounts",
        "describe",
        email,
        project,
        "--format=value(email)",
      ]);
      if (!exists.ok) {
        if (!isGcloudNotFound(exists.stderr)) {
          return { ok: false, done, error: `look up ${email}: ${exists.stderr.trim()}` };
        }
        pending.push(
          `${g.role} on ${url} for the staging gateway: its account does not exist yet, so staging's search answers 503 until upgrade sets the staging gateway up and grants it`,
        );
        continue;
      }
    }
    // The gateway's account may have been created a moment ago; IAM answers
    // "does not exist" until it has propagated, so this is retried.
    const r = await runWithRetry(run, sleep, [
      "storage",
      "buckets",
      "add-iam-policy-binding",
      url,
      `--member=serviceAccount:${email}`,
      `--role=${g.role}`,
      // A bucket whose policy holds a conditional binding refuses an
      // unconditional grant in non-interactive mode unless it says so.
      "--condition=None",
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok)
      return { ok: false, done, error: `grant ${g.role} on ${url} (${g.why}): ${r.stderr.trim()}` };
    done.push(`${g.member}: ${g.role} on ${url}`);
  }

  const logs = await ensureVisitorQueryLogExclusion(target, { run });
  done.push(...logs.done);
  if (!logs.ok) return { ok: false, done, error: logs.error };
  return { ok: true, done, pending };
}

/** The `gcp` stack's edge log sink to BigQuery (stacks/gcp/index.ts). */
export function edgeLogSinkName(env: string): string {
  return `${gcpNamePrefix(env)}-edge-log-sink`;
}

/** One exclusion as `gcloud logging sinks describe --format=json` shows it. */
interface LiveExclusion {
  readonly name?: string;
  readonly filter?: string;
  readonly disabled?: boolean;
}

/**
 * The dict-flag value of the exclusion. `^;^` makes `;` the delimiter: the
 * filter and the description carry commas (`gcloud topic escaping`).
 */
export function visitorQueryExclusionFlag(env: string): string {
  return `^;^name=${visitorQueryLogExclusionName(env)};filter=${VISITOR_QUERY_LOG_FILTER};description=${VISITOR_QUERY_LOG_DESCRIPTION}`;
}

/**
 * Put {@link VISITOR_QUERY_LOG_FILTER} on `_Default` and, where it exists,
 * the `gcp` edge log sink. An exclusion that is there with another filter
 * or disabled is replaced in one update (remove, then add). Sinks the
 * Owner created themselves are theirs; Caelo routes nothing through them.
 */
export async function ensureVisitorQueryLogExclusion(
  target: Pick<CollectionStoresTarget, "provider" | "projectId" | "env">,
  deps: { run?: GcloudRunner } = {},
): Promise<{ ok: true; done: string[] } | { ok: false; done: string[]; error: string }> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${target.projectId}`;
  const name = visitorQueryLogExclusionName(target.env);
  const done: string[] = [];
  const sinks = [
    DEFAULT_LOG_SINK,
    ...(target.provider === "gcp" ? [edgeLogSinkName(target.env)] : []),
  ];
  for (const sink of sinks) {
    const described = await run(["logging", "sinks", "describe", sink, project, "--format=json"]);
    if (!described.ok) {
      // The edge sink exists from the gcp stack's first `pulumi up` on; an
      // install without it has nothing to exclude there.
      if (sink !== DEFAULT_LOG_SINK && isGcloudNotFound(described.stderr)) continue;
      return { ok: false, done, error: `look up log sink ${sink}: ${described.stderr.trim()}` };
    }
    let live: LiveExclusion | undefined;
    try {
      const parsed = JSON.parse(described.stdout) as { exclusions?: LiveExclusion[] };
      live = (parsed.exclusions ?? []).find((e) => e.name === name);
    } catch {
      return { ok: false, done, error: `log sink ${sink}: gcloud printed no JSON` };
    }
    if (live && live.filter === VISITOR_QUERY_LOG_FILTER && live.disabled !== true) {
      done.push(`log sink ${sink}: exclusion ${name}`);
      continue;
    }
    const update = await run([
      "logging",
      "sinks",
      "update",
      sink,
      project,
      ...(live ? [`--remove-exclusions=${name}`] : []),
      `--add-exclusion=${visitorQueryExclusionFlag(target.env)}`,
      "--quiet",
    ]);
    if (!update.ok) {
      return {
        ok: false,
        done,
        error: `exclude visitors' search queries from log sink ${sink}: ${update.stderr.trim()}`,
      };
    }
    done.push(`log sink ${sink}: exclusion ${name} (${live ? "replaced" : "added"})`);
  }
  return { ok: true, done };
}
