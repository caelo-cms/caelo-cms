// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 — the collection stores of a Google Cloud install and the log
 * exclusion for visitors' search queries (collections-setup.ts,
 * visitor-query-logs.ts), against a fake gcloud. The load-bearing
 * assertions: both buckets private, the admin the only writer, each gateway
 * a reader of its own environment's store only, and the exclusion filter
 * dropping exactly the GETs that carry a visitor's query.
 */

import { describe, expect, it } from "bun:test";
import {
  COLLECTION_STORE_GRANTS,
  edgeLogSinkName,
  ensureCollectionStores,
  ensureVisitorQueryLogExclusion,
  visitorQueryExclusionFlag,
} from "./collections-setup.js";
import type { GcloudResult } from "./gcloud.js";
import { VISITOR_QUERY_LOG_FILTER } from "./visitor-query-logs.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const TARGET = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
} as const;

const STAGING = "gs://acme-caelo-production-coll-staging";
const LIVE = "gs://acme-caelo-production-coll-live";
const ADMIN = "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com";
const GATEWAY = "serviceAccount:caelo-production-gateway-sa@acme.iam.gserviceaccount.com";
const STG_GATEWAY = "serviceAccount:caelo-production-stg-gw-sa@acme.iam.gserviceaccount.com";

function fakeGcloud(rules: [RegExp, GcloudResult][] = []) {
  const calls: string[][] = [];
  const all: [RegExp, GcloudResult][] = [
    ...rules,
    [/^storage buckets describe/, fail("ERROR: (gcloud.storage.buckets.describe) NOT_FOUND: 404")],
    [/^logging sinks describe _Default/, ok(JSON.stringify({ name: "_Default" }))],
  ];
  const run = async (args: string[]) => {
    calls.push(args);
    const line = args.join(" ");
    return all.find(([re]) => re.test(line))?.[1] ?? ok("");
  };
  return { run, calls };
}

const flag = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function bucketGrants(calls: string[][]) {
  return calls
    .filter((c) => c[0] === "storage" && c[2] === "add-iam-policy-binding")
    .map((c) => [c[3], flag(c, "member"), flag(c, "role")]);
}

describe("ensureCollectionStores", () => {
  it("creates both stores private, in the install's region, without soft delete", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    const created = calls.filter((c) => c[0] === "storage" && c[2] === "create");
    expect(created.map((c) => c[3])).toEqual([STAGING, LIVE]);
    for (const c of created) {
      expect(c).toContain("--location=europe-west1");
      expect(c).toContain("--uniform-bucket-level-access");
      expect(c).toContain("--public-access-prevention");
      expect(c).toContain("--soft-delete-duration=0");
    }
  });

  it("lets the admin write both and each gateway read only its own store", async () => {
    const { run, calls } = fakeGcloud();
    await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    expect(bucketGrants(calls)).toEqual([
      [STAGING, ADMIN, "roles/storage.objectAdmin"],
      [LIVE, ADMIN, "roles/storage.objectAdmin"],
      [LIVE, GATEWAY, "roles/storage.objectViewer"],
      [STAGING, STG_GATEWAY, "roles/storage.objectViewer"],
    ]);
    // No public principal anywhere, and no gateway ever writes.
    for (const g of COLLECTION_STORE_GRANTS) {
      if (g.member !== "admin") expect(g.role).toBe("roles/storage.objectViewer");
    }
    expect(calls.some((c) => c.join(" ").includes("allUsers"))).toBe(false);
  });

  it("keeps existing buckets and creates nothing twice", async () => {
    const { run, calls } = fakeGcloud([
      [/^storage buckets describe/, ok("acme-caelo-production-coll-x")],
    ]);
    const r = await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[0] === "storage" && c[2] === "create")).toBe(false);
  });

  it("names a bucket another project holds instead of failing obscurely", async () => {
    const { run } = fakeGcloud([
      [
        /^storage buckets create/,
        fail("ERROR: HTTPError 409: The requested bucket name is not available."),
      ],
    ]);
    const r = await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("exists but does not belong to project acme");
  });

  it("waits for the staging gateway's account instead of failing, and says when it comes", async () => {
    const { run, calls } = fakeGcloud([
      [/^iam service-accounts describe caelo-production-stg-gw-sa/, fail("NOT_FOUND: 404")],
    ]);
    const r = await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pending).toHaveLength(1);
      expect(r.pending[0]).toContain("staging gateway");
    }
    expect(bucketGrants(calls).some((g) => g[1] === STG_GATEWAY)).toBe(false);
  });

  it("stops at a failed grant and says which", async () => {
    const { run } = fakeGcloud([
      [
        /add-iam-policy-binding gs:\/\/acme-caelo-production-coll-live --member=serviceAccount:caelo-production-gateway-sa/,
        fail("PERMISSION_DENIED"),
      ],
    ]);
    const r = await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`roles/storage.objectViewer on ${LIVE}`);
  });

  it("puts the search-query exclusion on the project's logs as its last step", async () => {
    const { run, calls } = fakeGcloud();
    await ensureCollectionStores(TARGET, { run, sleep: async () => {} });
    const update = calls.find((c) => c.slice(0, 3).join(" ") === "logging sinks update");
    expect(update?.[3]).toBe("_Default");
  });
});

describe("the visitor-query log exclusion", () => {
  /** Cloud Logging's `=~` is RE2, matched anywhere; JS's RegExp agrees on this pattern. */
  const urlPattern = new RegExp(
    (/requestUrl=~"([^"]+)"/.exec(VISITOR_QUERY_LOG_FILTER) as RegExpExecArray)[1] as string,
  );

  it("matches only GETs whose URL is a collection operation with a query string", () => {
    expect(VISITOR_QUERY_LOG_FILTER.startsWith('httpRequest.requestMethod="GET" AND ')).toBe(true);
    for (const url of [
      "https://acme.com/api/plugin/site-search/search?q=preise&lang=de&release=release-0123456789abcdef01234567.json",
      "https://acme.com/api/plugin/site-search/suggest?q=pr&lang=de",
      "https://caelo-production-data-gateway-abc.a.run.app/api/plugin/site-search/read?value=%2Fpreise%2F",
    ]) {
      expect(urlPattern.test(url)).toBe(true);
    }
    for (const url of [
      "https://acme.com/api/plugin/site-search/search/release",
      "https://acme.com/api/captcha/challenge",
      "https://acme.com/api/_caelo/mail-link/newsletter/confirm?t=x",
      "https://acme.com/preise/?q=x",
    ]) {
      expect(urlPattern.test(url)).toBe(false);
    }
  });

  it("passes the filter through gcloud's dict flag without a comma split", () => {
    const flagValue = visitorQueryExclusionFlag("production");
    expect(flagValue.startsWith("^;^name=caelo-production-visitor-queries;filter=")).toBe(true);
    expect(flagValue.split(";").length).toBe(4);
    expect(VISITOR_QUERY_LOG_FILTER).not.toContain(";");
  });

  it("adds it to _Default and, on gcp, to the edge log sink", async () => {
    const { run, calls } = fakeGcloud([
      [
        /^logging sinks describe caelo-production-edge-log-sink/,
        ok(JSON.stringify({ exclusions: [] })),
      ],
    ]);
    const r = await ensureVisitorQueryLogExclusion({ ...TARGET, provider: "gcp" }, { run });
    expect(r.ok).toBe(true);
    const updates = calls.filter((c) => c.slice(0, 3).join(" ") === "logging sinks update");
    expect(updates.map((c) => c[3])).toEqual(["_Default", edgeLogSinkName("production")]);
    for (const u of updates) {
      expect(u).toContain(`--add-exclusion=${visitorQueryExclusionFlag("production")}`);
      expect(u.some((a) => a.startsWith("--remove-exclusions"))).toBe(false);
    }
  });

  it("leaves an exclusion in place alone, and replaces a changed or disabled one", async () => {
    const same = { name: "caelo-production-visitor-queries", filter: VISITOR_QUERY_LOG_FILTER };
    const a = fakeGcloud([
      [/^logging sinks describe _Default/, ok(JSON.stringify({ exclusions: [same] }))],
    ]);
    await ensureVisitorQueryLogExclusion(TARGET, { run: a.run });
    expect(a.calls.some((c) => c[2] === "update")).toBe(false);
    for (const live of [
      { ...same, filter: 'httpRequest.requestUrl=~"/api/"' },
      { ...same, disabled: true },
    ]) {
      const b = fakeGcloud([
        [/^logging sinks describe _Default/, ok(JSON.stringify({ exclusions: [live] }))],
      ]);
      await ensureVisitorQueryLogExclusion(TARGET, { run: b.run });
      const update = b.calls.find((c) => c[2] === "update") ?? [];
      expect(update).toContain("--remove-exclusions=caelo-production-visitor-queries");
      expect(update).toContain(`--add-exclusion=${visitorQueryExclusionFlag("production")}`);
    }
  });

  it("skips an edge sink a gcp install does not have, but never a missing _Default", async () => {
    const a = fakeGcloud([
      [/^logging sinks describe caelo-production-edge-log-sink/, fail("NOT_FOUND: 404")],
    ]);
    expect(
      (await ensureVisitorQueryLogExclusion({ ...TARGET, provider: "gcp" }, { run: a.run })).ok,
    ).toBe(true);
    const b = fakeGcloud([[/^logging sinks describe _Default/, fail("PERMISSION_DENIED")]]);
    const r = await ensureVisitorQueryLogExclusion(TARGET, { run: b.run });
    expect(r.ok).toBe(false);
  });

  it("is what the gcp stack declares on its edge log sink", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dir, "../stacks/gcp/index.ts"), "utf8");
    expect(src).toContain("name: visitorQueryLogExclusionName(env),");
    expect(src).toContain("filter: VISITOR_QUERY_LOG_FILTER,");
  });
});
