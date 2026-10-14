// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — Confirm-publish on `gcp` writes the redirect plan into the URL map
 * routing the site host: redirect rules replaced, the stack's routing kept,
 * fingerprint carried, no write when nothing changed, loud failures.
 */

import { describe, expect, it } from "bun:test";
import { buildRedirectPlan, GcpUrlMapBudgetError, type RedirectPlan } from "@caelo-cms/shared";
import {
  applyGcpRedirectPlan,
  type GcpComputeApi,
  type GcpOperation,
  type GcpUrlMap,
} from "../gcp-url-map-redirects.js";

const plan = (rows: [string, string, number][]): RedirectPlan =>
  buildRedirectPlan({
    rows: rows.map(([fromPath, toPath, statusCode]) => ({ fromPath, toPath, statusCode })),
    pageUrlStyle: "directory",
    servedFiles: new Set(),
  });

const API_RULE = { paths: ["/api/*"], service: "projects/p/global/backendServices/gw" };

function siteMap(extraRules: unknown[] = []): GcpUrlMap {
  return {
    name: "caelo-production-url-map-1a2b",
    fingerprint: "fp-1",
    defaultService: "bucket",
    hostRules: [
      { hosts: ["example.com"], pathMatcher: "public" },
      { hosts: ["admin.example.com"], pathMatcher: "admin" },
    ],
    pathMatchers: [
      { name: "public", defaultService: "bucket", pathRules: [API_RULE, ...extraRules] },
      { name: "admin", defaultService: "admin-backend" },
    ],
  } as GcpUrlMap;
}

function fakeApi(maps: GcpUrlMap[], ops: GcpOperation[] = []) {
  const updates: { name: string; body: GcpUrlMap }[] = [];
  const waits: string[] = [];
  const api: GcpComputeApi = {
    listUrlMaps: async () => maps,
    updateUrlMap: async (name, body) => {
      updates.push({ name, body });
      return ops.shift() ?? { name: "op-1", status: "RUNNING" };
    },
    waitOperation: async (name) => {
      waits.push(name);
      return ops.shift() ?? { name, status: "DONE" };
    },
  };
  return { api, updates, waits };
}

describe("applyGcpRedirectPlan", () => {
  it("writes the plan's rules into the site host's path matcher, keeping /api/*", async () => {
    const stale = { paths: ["/stale"], urlRedirect: { pathRedirect: "/x/" } };
    const { api, updates, waits } = fakeApi([siteMap([stale])]);
    const result = await applyGcpRedirectPlan({
      plan: plan([
        ["/old", "/new", 301],
        ["/tmp", "/x", 308],
      ]),
      siteHost: "example.com",
      api,
    });
    expect(result).toEqual({
      urlMap: "caelo-production-url-map-1a2b",
      pathMatcher: "public",
      redirectRules: 2,
      changed: true,
    });
    expect(updates).toHaveLength(1);
    const body = updates[0]?.body;
    expect(updates[0]?.name).toBe("caelo-production-url-map-1a2b");
    expect(body?.fingerprint).toBe("fp-1");
    expect(body?.pathMatchers?.[1]).toEqual({ name: "admin", defaultService: "admin-backend" });
    expect(body?.pathMatchers?.[0]?.pathRules).toEqual([
      API_RULE,
      {
        paths: ["/old", "/old/"],
        urlRedirect: {
          pathRedirect: "/new/",
          redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
          stripQuery: false,
        },
      },
      {
        paths: ["/tmp", "/tmp/"],
        urlRedirect: {
          pathRedirect: "/x/",
          redirectResponseCode: "PERMANENT_REDIRECT",
          stripQuery: false,
        },
      },
    ]);
    expect(waits).toEqual(["op-1"]);
  });

  it("writes nothing when the live rules already match (fields the API adds ignored)", async () => {
    const live = {
      paths: ["/old", "/old/"],
      urlRedirect: {
        pathRedirect: "/new/",
        redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
        stripQuery: false,
        httpsRedirect: false,
      },
    };
    const { api, updates } = fakeApi([siteMap([live])]);
    const result = await applyGcpRedirectPlan({
      plan: plan([["/old", "/new", 301]]),
      siteHost: "example.com",
      api,
    });
    expect(result.changed).toBe(false);
    expect(updates).toEqual([]);
  });

  it("removes every redirect rule for an empty plan", async () => {
    const { api, updates } = fakeApi([siteMap([{ paths: ["/a"], urlRedirect: {} }])]);
    await applyGcpRedirectPlan({ plan: plan([]), siteHost: "example.com", api });
    expect(updates[0]?.body.pathMatchers?.[0]?.pathRules).toEqual([API_RULE]);
  });

  it("refuses an over-quota plan before writing anything", async () => {
    const { api, updates } = fakeApi([siteMap()]);
    const rows = Array.from(
      { length: 500 },
      (_, i) => [`/p${i}`, "/x", 301] as [string, string, number],
    );
    await expect(
      applyGcpRedirectPlan({ plan: plan(rows), siteHost: "example.com", api }),
    ).rejects.toBeInstanceOf(GcpUrlMapBudgetError);
    expect(updates).toEqual([]);
  });

  it("fails loudly when no URL map, or more than one, routes the host", async () => {
    await expect(
      applyGcpRedirectPlan({
        plan: plan([]),
        siteHost: "other.com",
        api: fakeApi([siteMap()]).api,
      }),
    ).rejects.toThrow(/no URL map in this project routes other.com/);
    await expect(
      applyGcpRedirectPlan({
        plan: plan([]),
        siteHost: "example.com",
        api: fakeApi([siteMap(), { ...siteMap(), name: "copy" }]).api,
      }),
    ).rejects.toThrow(/2 URL maps route example.com/);
  });

  it("surfaces a failed operation", async () => {
    const { api } = fakeApi(
      [siteMap()],
      [
        { name: "op-9", status: "RUNNING" },
        {
          name: "op-9",
          status: "DONE",
          error: { errors: [{ code: "QUOTA_EXCEEDED", message: "too many" }] },
        },
      ],
    );
    await expect(
      applyGcpRedirectPlan({ plan: plan([["/a", "/b", 301]]), siteHost: "example.com", api }),
    ).rejects.toThrow(/QUOTA_EXCEEDED: too many/);
  });

  it("gives up waiting after the deadline", async () => {
    let t = 0;
    const api: GcpComputeApi = {
      listUrlMaps: async () => [siteMap()],
      updateUrlMap: async () => ({ name: "op-slow", status: "RUNNING" }),
      waitOperation: async (name) => {
        t += 61_000;
        return { name, status: "RUNNING" };
      },
    };
    await expect(
      applyGcpRedirectPlan({
        plan: plan([["/a", "/b", 301]]),
        siteHost: "example.com",
        api,
        now: () => t,
      }),
    ).rejects.toThrow(/did not finish within 5 minutes/);
  });
});
