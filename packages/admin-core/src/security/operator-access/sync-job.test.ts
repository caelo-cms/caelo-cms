// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "./google-iam.js";
import {
  configFromEnv,
  IAP_ACCESSOR_ROLE,
  iamDatabaseUrls,
  type LogEntry,
  runSync,
  type SyncJobConfig,
  TOKEN_CREATOR_ROLE,
} from "./sync-job.js";

const IAP =
  "https://iap.googleapis.com/v1/projects/123/iap_web/cloud_run-europe-west1/services/adm";
const SA =
  "https://iam.googleapis.com/v1/projects/-/serviceAccounts/caelo-mcp%40p.iam.gserviceaccount.com";
const MCP = "serviceAccount:caelo-mcp@p.iam.gserviceaccount.com";
const JOB_GRANT = {
  role: "projects/p/roles/caeloOperatorAccess",
  members: ["serviceAccount:job@p.iam.gserviceaccount.com"],
};

const config: SyncJobConfig = {
  iapWebPath: "cloud_run-europe-west1/services/adm",
  mcpServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
  staticMembers: "user:owner@x.com",
  databaseHost: "10.0.0.3",
};

/** Fake IAP + IAM policy endpoints holding real state. */
function fakeGoogle(policies: Record<string, unknown>, failSetFor?: string) {
  const sets: { url: string; policy: unknown }[] = [];
  const deps: GoogleDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const base = url.replace(/:(get|set)IamPolicy.*$/, "");
      if (url.includes(":getIamPolicy")) {
        return new Response(JSON.stringify(policies[base] ?? {}), { status: 200 });
      }
      if (failSetFor && base === failSetFor) {
        return new Response("denied", { status: 403 });
      }
      const policy = (JSON.parse(String(init?.body)) as { policy: unknown }).policy;
      sets.push({ url: base, policy });
      policies[base] = policy;
      return new Response(JSON.stringify(policy), { status: 200 });
    }) as typeof fetch,
    accessToken: async () => "tok",
    metadata: async (path) => (path === "project/numeric-project-id" ? "123\n" : ""),
  };
  return { deps, sets, policies };
}

function collect() {
  const logs: LogEntry[] = [];
  return { logs, log: (e: LogEntry) => logs.push(e) };
}

const membersOf = (policy: unknown, role: string) =>
  ((policy as { bindings?: { role: string; members: string[] }[] }).bindings ?? [])
    .filter((b) => b.role === role)
    .flatMap((b) => b.members);

describe("runSync", () => {
  it("makes both roles hold exactly the users with a role plus the allowlist — and keeps the job's own grant", async () => {
    const { deps, policies } = fakeGoogle({
      [IAP]: {
        etag: "a",
        bindings: [
          {
            role: IAP_ACCESSOR_ROLE,
            members: ["user:owner@x.com", "allUsers", "domain:x.com", "user:gone@x.com"],
          },
          JOB_GRANT,
        ],
      },
      [SA]: {
        etag: "b",
        bindings: [{ role: TOKEN_CREATOR_ROLE, members: ["group:g@x.com"] }, JOB_GRANT],
      },
    });
    const { logs, log } = collect();
    const r = await runSync(config, { google: deps, readEmails: async () => ["anna@x.com"], log });
    expect(r.ok).toBe(true);
    expect(membersOf(policies[IAP], IAP_ACCESSOR_ROLE)).toEqual([
      MCP,
      "user:anna@x.com",
      "user:owner@x.com",
    ]);
    expect(membersOf(policies[SA], TOKEN_CREATOR_ROLE)).toEqual([
      "user:anna@x.com",
      "user:owner@x.com",
    ]);
    expect(membersOf(policies[IAP], JOB_GRANT.role)).toEqual(JOB_GRANT.members);
    expect(membersOf(policies[SA], JOB_GRANT.role)).toEqual(JOB_GRANT.members);
    // Every removal is logged loudly.
    const removed = logs.filter((l) => l.severity === "WARNING").map((l) => l.member);
    expect(removed).toEqual(["allUsers", "domain:x.com", "user:gone@x.com", "group:g@x.com"]);
  });

  it("writes nothing when the policies already match (self-healing run on a clean install)", async () => {
    const { deps, sets } = fakeGoogle({
      [IAP]: { bindings: [{ role: IAP_ACCESSOR_ROLE, members: ["user:owner@x.com", MCP] }] },
      [SA]: { bindings: [{ role: TOKEN_CREATOR_ROLE, members: ["user:owner@x.com"] }] },
    });
    const { log } = collect();
    const r = await runSync(config, { google: deps, readEmails: async () => [], log });
    expect(r.ok).toBe(true);
    expect(sets).toEqual([]);
  });

  it("never grants an invalid email or a public/domain static member, and fails the run for the latter", async () => {
    const { deps, policies } = fakeGoogle({});
    const { logs, log } = collect();
    const r = await runSync(
      { ...config, staticMembers: "user:owner@x.com,allUsers,domain:x.com" },
      { google: deps, readEmails: async () => ["not an email", "*@x.com"], log },
    );
    expect(r.ok).toBe(false);
    expect(membersOf(policies[IAP], IAP_ACCESSOR_ROLE)).toEqual([MCP, "user:owner@x.com"]);
    expect(logs.filter((l) => l.severity === "ERROR").map((l) => l.message)).toEqual([
      'static member "allUsers" ignored: only user:, group: and serviceAccount: principals are ever granted',
      'static member "domain:x.com" ignored: only user:, group: and serviceAccount: principals are ever granted',
    ]);
  });

  it("a failed write fails the run but still reconciles the other binding", async () => {
    const { deps, policies } = fakeGoogle({}, IAP);
    const { logs, log } = collect();
    const r = await runSync(config, { google: deps, readEmails: async () => ["anna@x.com"], log });
    expect(r.ok).toBe(false);
    expect(logs.some((l) => l.severity === "ERROR" && String(l.message).includes("HTTP 403"))).toBe(
      true,
    );
    expect(membersOf(policies[SA], TOKEN_CREATOR_ROLE)).toEqual([
      "user:anna@x.com",
      "user:owner@x.com",
    ]);
  });

  it("writes nothing when the user list cannot be read", async () => {
    const { deps, sets } = fakeGoogle({});
    const { log } = collect();
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => {
        throw new Error("permission denied for table users");
      },
      log,
    });
    expect(r).toEqual({ ok: false });
    expect(sets).toEqual([]);
  });
});

describe("configFromEnv", () => {
  it("names every missing variable", () => {
    expect(() => configFromEnv({ CAELO_MCP_IAP_SERVICE_ACCOUNT: "x" })).toThrow(
      "missing env CAELO_OPERATOR_ACCESS_IAP_WEB, CAELO_OPERATOR_ACCESS_STATIC_MEMBERS, CAELO_OPERATOR_ACCESS_DB_HOST",
    );
  });
});

describe("iamDatabaseUrls", () => {
  it("logs in as the service account's IAM database user with the token as password", () => {
    expect(iamDatabaseUrls("10.0.0.3", "job@p.iam.gserviceaccount.com", "ya29/x")).toEqual({
      user: "job@p.iam",
      admin: "postgresql://job%40p.iam:ya29%2Fx@10.0.0.3:5432/cms_admin?sslmode=require",
      public: "postgresql://job%40p.iam:ya29%2Fx@10.0.0.3:5432/cms_public?sslmode=require",
    });
  });
});
