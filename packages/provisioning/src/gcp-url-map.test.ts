// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — the `gcp` stack's URL map under Pulumi mocks: host routing, the
 * public path matcher the admin writes redirect rules into, the field the
 * stack ignores after creation; the admin's custom role is the CLI's.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GCP_PUBLIC_BASE_PATHS, isGcpRedirectRule, withGcpRedirects } from "@caelo-cms/shared";
import * as pulumi from "@pulumi/pulumi";
import { URL_MAP_REDIRECTS_PERMISSIONS, urlMapRedirectsRoleId } from "./gcp-names.js";

interface Registered {
  readonly type: string;
  readonly name: string;
  readonly inputs: Record<string, unknown>;
}
const registered: Registered[] = [];

beforeAll(() => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        registered.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "caelo",
    "production",
    false,
  );
});

const resolved = <T>(o: pulumi.Output<T>): Promise<T> => new Promise((r) => o.apply(r));

describe("gcp stack URL map (Pulumi mocks)", () => {
  it("routes the site host to the bucket with /api/* to the gateway, the admin host to the admin", async () => {
    // Imported after setMocks so the resource registers against the mock monitor.
    const { createSiteUrlMap, PUBLIC_PATH_MATCHER } = await import("./gcp-url-map.js");
    const map = createSiteUrlMap(
      "caelo-production-url-map",
      {
        domain: "example.com",
        adminDomain: "admin.example.com",
        staticBackend: "bucket-id",
        gatewayBackend: "gateway-id",
        adminBackend: "admin-id",
      },
      {},
    );
    const [hostRules, pathMatchers, defaultService] = await Promise.all([
      resolved(map.hostRules),
      resolved(map.pathMatchers),
      resolved(map.defaultService),
    ]);
    expect(defaultService).toBe("bucket-id");
    expect(hostRules).toEqual([
      { hosts: ["example.com"], pathMatcher: PUBLIC_PATH_MATCHER },
      { hosts: ["admin.example.com"], pathMatcher: "admin" },
    ]);
    expect(pathMatchers).toEqual([
      {
        name: PUBLIC_PATH_MATCHER,
        defaultService: "bucket-id",
        pathRules: [{ paths: [...GCP_PUBLIC_BASE_PATHS], service: "gateway-id" }],
      },
      { name: "admin", defaultService: "admin-id" },
    ]);
    expect(registered.find((r) => r.name === "caelo-production-url-map")?.type).toBe(
      "gcp:compute/uRLMap:URLMap",
    );

    // The rules the admin writes on Confirm-publish fit this matcher and keep
    // its routing — the base the Stage-time budget check assumes.
    const first = pathMatchers?.[0];
    if (!first) throw new Error("no public path matcher");
    const withRedirects = withGcpRedirects(
      {
        name: first.name,
        pathRules: (first.pathRules ?? []).map((r) => ({
          paths: r.paths ?? [],
          service: r.service ?? "",
        })),
      },
      {
        redirects: [
          {
            fromPath: "/old",
            matchPaths: ["/old", "/old/"],
            location: "/new/",
            statusCode: 301,
            preserveQuery: true,
          },
        ],
        gone: [],
        shadowedByBuild: [],
      },
    );
    expect(withRedirects.pathRules?.filter((r) => !isGcpRedirectRule(r))).toEqual([
      { paths: ["/api/*"], service: "gateway-id" },
    ]);
  });

  it("ignores the public path matcher's path rules after creation (the admin owns the redirects)", async () => {
    const { SITE_URL_MAP_IGNORE_CHANGES, siteUrlMapArgs, PUBLIC_PATH_MATCHER } = await import(
      "./gcp-url-map.js"
    );
    expect(SITE_URL_MAP_IGNORE_CHANGES).toEqual(["pathMatchers[0].pathRules"]);
    const args = siteUrlMapArgs({
      domain: "d",
      adminDomain: "a.d",
      staticBackend: "s",
      gatewayBackend: "g",
      adminBackend: "a",
    });
    // Index 0 must stay the public matcher, or the ignore would hit the admin's.
    expect((args.pathMatchers as { name: string }[])[0]?.name).toBe(PUBLIC_PATH_MATCHER);
  });
});

describe("gcp stack wiring (source)", () => {
  const src = readFileSync(resolve(import.meta.dir, "../stacks/gcp/index.ts"), "utf8");

  it("builds the URL map through createSiteUrlMap", () => {
    expect(src).toMatch(/const urlMap = createSiteUrlMap\(\s*`\$\{namePrefix\}-url-map`/);
    expect(src).not.toMatch(/new gcp\.compute\.URLMap\(\s*`\$\{namePrefix\}-url-map`/);
  });

  it("leaves the admin's URL-map redirects role to the CLI (installer + upgrade)", () => {
    expect(src).not.toContain("IAMCustomRole");
    expect(src).not.toContain("urlMapRedirects");
  });

  it("names a valid custom role id with only the permissions the writer needs", () => {
    expect(urlMapRedirectsRoleId("production")).toBe("caelo_production_urlMapRedirects");
    expect(urlMapRedirectsRoleId("production")).toMatch(/^[A-Za-z0-9_.]{3,64}$/);
    expect([...URL_MAP_REDIRECTS_PERMISSIONS].sort()).toEqual([
      "compute.backendBuckets.use",
      "compute.backendServices.use",
      "compute.globalOperations.get",
      "compute.urlMaps.get",
      "compute.urlMaps.list",
      "compute.urlMaps.update",
    ]);
  });
});
