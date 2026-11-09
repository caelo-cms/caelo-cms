// SPDX-License-Identifier: MPL-2.0

/**
 * #1454, contract 24 — what the admin's run SA needs on `gcp` for Publish
 * live (and rollback) to put a build's page headers on the static backend
 * bucket. Contract 23 granted the Compute half; the first real install then
 * failed with `GCS_BUCKET_ACCESS_DENIED`, because Compute also checks the
 * Cloud Storage bucket the backend bucket serves as the caller. These tests
 * tie each API call of the header writer to the permission it needs and to
 * the grant that carries it, so a new call or a dropped grant fails here
 * instead of at an Owner's Publish live.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GCP_SITE_HEADERS_PERMISSIONS,
  STATIC_BUCKET_METADATA_ROLE,
  URL_MAP_REDIRECTS_PERMISSIONS,
} from "./gcp-names.js";
import { stackIamInvariants } from "./stack-contract.js";

const repo = resolve(import.meta.dir, "../../..");
const headerWriter = readFileSync(
  resolve(repo, "packages/admin-core/src/deploy/gcp-site-headers.ts"),
  "utf8",
);

/**
 * Each call of `GcpBackendBucketApi` (admin-core gcp-site-headers.ts) and
 * what Google checks for it. `backendBuckets.patch` checks the referenced
 * bucket too: its operation fails with `GCS_BUCKET_ACCESS_DENIED` when the
 * caller may not `storage.buckets.get` it (audit log of the v0.12.1 install,
 * 2026-11-09).
 */
const CALL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  listUrlMaps: ["compute.urlMaps.list"],
  getBackendBucket: ["compute.backendBuckets.get"],
  patchBackendBucket: ["compute.backendBuckets.update", "storage.buckets.get"],
  waitOperation: ["compute.globalOperations.get"],
};

/**
 * The bucket-level part of the Cloud Storage roles the run SA may hold on
 * the static bucket, as `gcloud iam roles describe` lists them. objectAdmin
 * is objects only: it has no `storage.buckets.*` permission at all.
 */
const STORAGE_ROLE_BUCKET_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  "roles/storage.objectAdmin": [],
  "roles/storage.bucketViewer": ["storage.buckets.get", "storage.buckets.list"],
};

/** The calls `GcpBackendBucketApi` declares, read from its source. */
function declaredCalls(src: string): string[] {
  const block = src.match(/export interface GcpBackendBucketApi[\s\S]*?\n\}/)?.[0];
  if (!block) throw new Error("GcpBackendBucketApi not found in gcp-site-headers.ts");
  const picked = [...(block.match(/Pick<GcpComputeApi,([^>]+)>/)?.[1] ?? "").matchAll(/"(\w+)"/g)]
    .map((m) => m[1] ?? "")
    .filter(Boolean);
  const own = [...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1] ?? "");
  return [...picked, ...own].sort();
}

describe("#1454 — the admin's page-header write on gcp", () => {
  it("knows the permission of every call the header writer makes", () => {
    const calls = declaredCalls(headerWriter);
    expect(calls).toEqual(Object.keys(CALL_PERMISSIONS).sort());
    const needed = calls.flatMap((c) => CALL_PERMISSIONS[c] ?? []);
    expect([...needed].sort()).toEqual(
      [
        ...GCP_SITE_HEADERS_PERMISSIONS.project,
        ...GCP_SITE_HEADERS_PERMISSIONS.staticBucket,
      ].sort(),
    );
  });

  it("grants the Compute half through the project custom role", () => {
    for (const p of GCP_SITE_HEADERS_PERMISSIONS.project) {
      expect(URL_MAP_REDIRECTS_PERMISSIONS).toContain(p);
    }
  });

  it("grants storage.buckets.get on the static bucket only, through bucketViewer", () => {
    const runSaStorage = stackIamInvariants("gcp").filter(
      (i) => i.member === "run-sa" && i.target.kind === "bucket",
    );
    const onStatic = runSaStorage
      .filter((i) => i.target.kind === "bucket" && i.target.bucket === "static")
      .map((i) => i.role)
      .sort();
    expect(onStatic).toEqual([STATIC_BUCKET_METADATA_ROLE, "roles/storage.objectAdmin"].sort());
    const granted = onStatic.flatMap((role) => {
      const perms = STORAGE_ROLE_BUCKET_PERMISSIONS[role];
      if (!perms) throw new Error(`unknown bucket-level permissions of ${role}`);
      return perms;
    });
    for (const p of GCP_SITE_HEADERS_PERMISSIONS.staticBucket) expect(granted).toContain(p);
    // Never IAM on the bucket, never a write of its settings.
    expect(granted.filter((p) => /IamPolicy|buckets\.(update|delete|create)/.test(p))).toEqual([]);
    // The metadata role lives on the static bucket and nowhere else.
    expect(
      runSaStorage
        .filter((i) => i.role === STATIC_BUCKET_METADATA_ROLE)
        .map((i) => i.target.kind === "bucket" && i.target.bucket),
    ).toEqual(["static"]);
    expect(
      stackIamInvariants("gcp").filter(
        (i) => i.role === STATIC_BUCKET_METADATA_ROLE && i.target.kind !== "bucket",
      ),
    ).toEqual([]);
  });

  it("aborts an upgrade that cannot add it: Publish live does not finish without it", () => {
    const binding = stackIamInvariants("gcp").find(
      (i) => i.stackResource === "admin-static-bucket-read",
    );
    expect(binding?.onFailure).toBe("abort");
  });

  it("gcp-firebase sets its headers in the Hosting version and needs no bucket read", () => {
    expect(
      stackIamInvariants("gcp-firebase").filter((i) => i.role === STATIC_BUCKET_METADATA_ROLE),
    ).toEqual([]);
  });
});
