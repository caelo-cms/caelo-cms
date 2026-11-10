// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  gcpBackendBucketHeaders,
} from "@caelo-cms/shared";
import { applyGcpSiteHeaders, type GcpBackendBucketApi } from "../gcp-site-headers.js";

const set = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS);

function fakeApi(live: readonly string[], status: "DONE" | "RUNNING" = "DONE") {
  const patches: { name: string; headers: readonly string[] }[] = [];
  const api: GcpBackendBucketApi = {
    listUrlMaps: async () => [
      {
        name: "map",
        hostRules: [{ hosts: ["www.example.com"], pathMatcher: "site" }],
        pathMatchers: [
          {
            name: "site",
            defaultService:
              "https://www.googleapis.com/compute/v1/projects/p/global/backendBuckets/static-backend-1",
          },
        ],
      },
    ],
    getBackendBucket: async (name) => ({ name, customResponseHeaders: live }),
    patchBackendBucket: async (name, body) => {
      patches.push({ name, headers: body.customResponseHeaders });
      return { name: "op-1", status };
    },
    waitOperation: async (name) => ({ name, status: "DONE" }),
  };
  return { api, patches };
}

describe("applyGcpSiteHeaders", () => {
  it("writes the build's headers to the bucket that serves the host", async () => {
    const { api, patches } = fakeApi(["X-Content-Type-Options: nosniff"], "RUNNING");
    expect(await applyGcpSiteHeaders({ set, siteHost: "www.example.com", api })).toBe(true);
    expect(patches).toEqual([{ name: "static-backend-1", headers: gcpBackendBucketHeaders(set) }]);
  });

  it("a build from before the headers keeps only nosniff, not the previous CSP", async () => {
    const { api, patches } = fakeApi(gcpBackendBucketHeaders(set));
    await applyGcpSiteHeaders({ set: null, siteHost: "www.example.com", api });
    expect(patches[0]?.headers).toEqual(["X-Content-Type-Options: nosniff"]);
  });

  it("writes nothing when the bucket already says it", async () => {
    const { api, patches } = fakeApi(gcpBackendBucketHeaders(set));
    expect(await applyGcpSiteHeaders({ set, siteHost: "www.example.com", api })).toBe(false);
    expect(patches).toEqual([]);
  });

  it("fails loudly when no bucket serves the host", async () => {
    const { api } = fakeApi([]);
    await expect(applyGcpSiteHeaders({ set, siteHost: "other.example.com", api })).rejects.toThrow(
      "no single static backend bucket serves other.example.com",
    );
  });

  it("reports a failed operation", async () => {
    const { api } = fakeApi([], "RUNNING");
    const failing: GcpBackendBucketApi = {
      ...api,
      waitOperation: async (name) => ({
        name,
        status: "DONE",
        error: { errors: [{ code: "PERMISSION", message: "no" }] },
      }),
    };
    await expect(
      applyGcpSiteHeaders({ set, siteHost: "www.example.com", api: failing }),
    ).rejects.toThrow("PERMISSION: no");
  });

  it("names the missing bucket read and the update that grants it (contract 24)", async () => {
    // The operation a v0.12.1 install's Publish live got back (audit log,
    // 2026-11-09): the patch was accepted, Compute refused the bucket.
    const { api } = fakeApi(["X-Content-Type-Options: nosniff"], "RUNNING");
    const denied: GcpBackendBucketApi = {
      ...api,
      waitOperation: async (name) => ({
        name,
        status: "DONE",
        error: {
          errors: [
            {
              code: "GCS_BUCKET_ACCESS_DENIED",
              message: "Access denied to the Cloud Storage bucket 'p-caelo-production-static'.",
            },
          ],
        },
      }),
    };
    const failure = applyGcpSiteHeaders({ set, siteHost: "www.example.com", api: denied });
    await expect(failure).rejects.toThrow("The files are live with the previous headers.");
    await expect(failure).rejects.toThrow("storage.buckets.get");
    await expect(failure).rejects.toThrow("roles/storage.bucketViewer");
    await expect(failure).rejects.toThrow("Settings → Updates");
    await expect(failure).rejects.toThrow("then Publish live again");
  });

  it("a Publish live after a failed write puts the headers on (nothing is cached as applied)", async () => {
    let live: readonly string[] = ["X-Content-Type-Options: nosniff"];
    let denied = true;
    const patches: (readonly string[])[] = [];
    const { api } = fakeApi([]);
    const flaky: GcpBackendBucketApi = {
      ...api,
      getBackendBucket: async (name) => ({ name, customResponseHeaders: live }),
      patchBackendBucket: async (_name, body) => {
        patches.push(body.customResponseHeaders);
        if (!denied) live = body.customResponseHeaders;
        return { name: "op", status: "RUNNING" };
      },
      waitOperation: async (name) =>
        denied
          ? { name, status: "DONE", error: { errors: [{ code: "GCS_BUCKET_ACCESS_DENIED" }] } }
          : { name, status: "DONE" },
    };
    await expect(
      applyGcpSiteHeaders({ set, siteHost: "www.example.com", api: flaky }),
    ).rejects.toThrow("GCS_BUCKET_ACCESS_DENIED");
    expect(live).toEqual(["X-Content-Type-Options: nosniff"]);
    denied = false; // the converge granted the bucket read
    expect(await applyGcpSiteHeaders({ set, siteHost: "www.example.com", api: flaky })).toBe(true);
    expect(live).toEqual(gcpBackendBucketHeaders(set));
    expect(patches).toHaveLength(2);
  });
});
