// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { recordedGoogleOAuthFetch } from "../google-sign-in/recorded-google-oauth.js";
import type { GoogleDeps } from "./google-iam.js";
import { classifySyncRun, refusedEmail } from "./run-report.js";
import {
  configFromEnv,
  IAP_ACCESSOR_ROLE,
  type LogEntry,
  recordRunReport,
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

/** #967 — Google's OAuth endpoints (recorded answers): every client complete. */
const OAUTH_OK = {
  fetch: recordedGoogleOAuthFetch({
    exists: () => true,
    registered: () => true,
    secretValid: () => true,
  }),
};

const config: SyncJobConfig = {
  iapWebPath: "cloud_run-europe-west1/services/adm",
  mcpServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
  staticMembers: "user:owner@x.com",
  databaseHost: "10.0.0.3",
  mcpSigners: "",
  oauthClientSecret: "projects/p/secrets/caelo-production-operator-oauth-client",
};

/** Fake IAP + IAM policy endpoints holding real state. */
function fakeGoogle(
  policies: Record<string, unknown>,
  failSetFor?: string,
  /** `user:` members Google answers "does not exist" for, like a real setIamPolicy. */
  nonexistent: readonly string[] = [],
) {
  const sets: { url: string; policy: unknown }[] = [];
  const deps: GoogleDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(":iapSettings")) {
        // #914 — oauthSettings; empty settings, accepted as sent.
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const base = url.replace(/:(get|set)IamPolicy.*$/, "");
      if (url.includes(":getIamPolicy")) {
        return new Response(JSON.stringify(policies[base] ?? {}), { status: 200 });
      }
      if (failSetFor && base === failSetFor) {
        return new Response("denied", { status: 403 });
      }
      const policy = (JSON.parse(String(init?.body)) as { policy: unknown }).policy;
      const missing = nonexistent.find((m) => JSON.stringify(policy).includes(`"${m}"`));
      if (missing) {
        const error = { code: 400, message: `User ${missing.slice(5)} does not exist.` };
        return new Response(JSON.stringify({ error }), { status: 400 });
      }
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
    const r = await runSync(config, {
      google: deps,
      oauthProbe: OAUTH_OK,
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => ({}),
      readEmails: async () => ["anna@x.com"],
      log,
    });
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

  it("leaves out a user Google has no account for, still removes allUsers, and reports the run as failed", async () => {
    const { deps, policies } = fakeGoogle(
      {
        [IAP]: {
          bindings: [{ role: IAP_ACCESSOR_ROLE, members: ["user:owner@x.com", MCP, "allUsers"] }],
        },
        [SA]: { bindings: [{ role: TOKEN_CREATOR_ROLE, members: ["user:owner@x.com"] }] },
      },
      undefined,
      ["user:nobody@x.com"],
    );
    const { logs, log } = collect();
    const r = await runSync(config, {
      google: deps,
      oauthProbe: OAUTH_OK,
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => ({}),
      readEmails: async () => ["anna@x.com", "Nobody@x.com"],
      log,
    });
    // #970 — refused members only: done with warnings, not failed (exit 0).
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("succeeded_with_warnings");
    expect(r.refusedMembers).toEqual(["nobody@x.com"]);
    expect(r.errorCount).toBe(0);
    expect(membersOf(policies[IAP], IAP_ACCESSOR_ROLE)).toEqual([
      MCP,
      "user:anna@x.com",
      "user:owner@x.com",
    ]);
    expect(membersOf(policies[SA], TOKEN_CREATOR_ROLE)).toEqual([
      "user:anna@x.com",
      "user:owner@x.com",
    ]);
    expect(r.iap?.unknownPrincipals).toEqual(["user:nobody@x.com"]);
    const errors = logs.filter((l) => l.severity === "ERROR");
    expect(errors.map((l) => [l.member, l.role])).toEqual([
      ["user:nobody@x.com", IAP_ACCESSOR_ROLE],
      ["user:nobody@x.com", TOKEN_CREATOR_ROLE],
    ]);
    expect(logs.some((l) => l.severity === "WARNING" && l.member === "allUsers")).toBe(true);
  });

  it("keeps the upgrader's token-creator on caelo-mcp, and only there", async () => {
    const UPGRADER = "serviceAccount:caelo-production-upgrader@p.iam.gserviceaccount.com";
    const { deps, policies } = fakeGoogle({
      [IAP]: { bindings: [{ role: IAP_ACCESSOR_ROLE, members: ["user:owner@x.com", MCP] }] },
      [SA]: { bindings: [{ role: TOKEN_CREATOR_ROLE, members: ["user:owner@x.com", UPGRADER] }] },
    });
    const { log } = collect();
    const r = await runSync(
      { ...config, mcpSigners: UPGRADER },
      {
        google: deps,
        oauthProbe: OAUTH_OK,
        readOAuthClientId: async () => null,
        readOAuthClientFile: async () => ({}),
        readEmails: async () => [],
        log,
      },
    );
    expect(r.ok).toBe(true);
    expect(membersOf(policies[SA], TOKEN_CREATOR_ROLE)).toEqual(["user:owner@x.com", UPGRADER]);
    expect(membersOf(policies[IAP], IAP_ACCESSOR_ROLE)).not.toContain(UPGRADER);
  });

  it("writes nothing when the policies already match (self-healing run on a clean install)", async () => {
    const { deps, sets } = fakeGoogle({
      [IAP]: { bindings: [{ role: IAP_ACCESSOR_ROLE, members: ["user:owner@x.com", MCP] }] },
      [SA]: { bindings: [{ role: TOKEN_CREATOR_ROLE, members: ["user:owner@x.com"] }] },
    });
    const { log } = collect();
    const r = await runSync(config, {
      google: deps,
      oauthProbe: OAUTH_OK,
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => ({}),
      readEmails: async () => [],
      log,
    });
    expect(r.ok).toBe(true);
    expect(sets).toEqual([]);
  });

  it("never grants an invalid email or a public/domain static member, and fails the run for the latter", async () => {
    const { deps, policies } = fakeGoogle({});
    const { logs, log } = collect();
    const r = await runSync(
      { ...config, staticMembers: "user:owner@x.com,allUsers,domain:x.com" },
      {
        google: deps,
        oauthProbe: OAUTH_OK,
        readOAuthClientId: async () => null,
        readOAuthClientFile: async () => ({}),
        readEmails: async () => ["not an email", "*@x.com"],
        log,
      },
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
    const r = await runSync(config, {
      google: deps,
      oauthProbe: OAUTH_OK,
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => ({}),
      readEmails: async () => ["anna@x.com"],
      log,
    });
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
      oauthProbe: OAUTH_OK,
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => ({}),
      readEmails: async () => {
        throw new Error("permission denied for table users");
      },
      log,
    });
    expect(r).toMatchObject({ ok: false, outcome: "failed", refusedMembers: [], errorCount: 1 });
    expect(sets).toEqual([]);
  });
});

describe("#970 run classification", () => {
  it("refused members only = done with warnings; any other error = failed", () => {
    expect(classifySyncRun({ refusedMembers: [], errorCount: 0 })).toBe("succeeded");
    expect(classifySyncRun({ refusedMembers: ["a@x.com"], errorCount: 0 })).toBe(
      "succeeded_with_warnings",
    );
    expect(classifySyncRun({ refusedMembers: ["a@x.com"], errorCount: 1 })).toBe("failed");
    expect(classifySyncRun({ refusedMembers: [], errorCount: 2 })).toBe("failed");
  });

  it("only user: members are refused users", () => {
    expect(refusedEmail("user:Anna@X.com")).toBe("anna@x.com");
    expect(refusedEmail("group:g@x.com")).toBeNull();
  });

  it("a refused member and a failed write: failed, still naming the refused member", async () => {
    const { deps } = fakeGoogle({}, IAP, ["user:nobody@x.com"]);
    const r = await runSync(config, {
      google: deps,
      oauthProbe: OAUTH_OK,
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => ({}),
      readEmails: async () => ["nobody@x.com"],
      log: () => {},
    });
    expect(r.outcome).toBe("failed");
    expect(r.refusedMembers).toEqual(["nobody@x.com"]);
  });
});

describe("recordRunReport", () => {
  const report = {
    ok: true,
    outcome: "succeeded_with_warnings" as const,
    refusedMembers: ["nobody@x.com"],
    errorCount: 0,
    signInClientProblem: null,
  };

  it("records the report under the Cloud Run execution", async () => {
    const calls: [string, unknown][] = [];
    const r = await recordRunReport(
      async (op, input) => {
        calls.push([op, input]);
        return {};
      },
      "caelo-production-operator-access-sync-abc12",
      report,
    );
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([
      [
        "users.record_operator_access_run",
        {
          execution: "caelo-production-operator-access-sync-abc12",
          outcome: "succeeded_with_warnings",
          refusedMembers: ["nobody@x.com"],
          errorCount: 0,
          signInClientProblem: null,
        },
      ],
    ]);
  });

  it("fails loudly without an execution id or when the write fails", async () => {
    const never = async () => {
      throw new Error("permission denied for table operator_access_sync_runs");
    };
    expect((await recordRunReport(never, undefined, report)).ok).toBe(false);
    const r = await recordRunReport(never, "exec", report);
    expect(r.ok === false && r.error).toContain("permission denied");
  });
});

describe("configFromEnv", () => {
  it("names every missing variable", () => {
    expect(() => configFromEnv({ CAELO_MCP_IAP_SERVICE_ACCOUNT: "x" })).toThrow(
      "missing env CAELO_OPERATOR_ACCESS_IAP_WEB, CAELO_OPERATOR_ACCESS_STATIC_MEMBERS, CAELO_OPERATOR_ACCESS_DB_HOST, CAELO_OPERATOR_OAUTH_CLIENT_SECRET",
    );
  });
});
