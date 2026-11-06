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
});
