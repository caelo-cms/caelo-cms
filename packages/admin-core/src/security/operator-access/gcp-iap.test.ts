// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type GcpIapDeps,
  type GcpIapEnv,
  gcpIapBackendFromEnv,
  IAP_ACCESSOR_ROLE,
  OperatorAccessError,
  TOKEN_CREATOR_ROLE,
} from "./gcp-iap.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

type Responder = (call: Call) => { status: number; body: unknown } | undefined;

/** Fake Google APIs: first responder that answers wins; default is 200 `{}`. */
function fakeGoogle(...responders: Responder[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const answer = responders.map((r) => r(call)).find((a) => a !== undefined) ?? {
      status: 200,
      body: {},
    };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const deps: GcpIapDeps = {
    fetch: fetchImpl,
    accessToken: async () => "tok",
    metadata: async (path) =>
      path === "project/project-id" ? "p\n" : "projects/123/regions/europe-west1",
  };
  return { deps, calls };
}

const FIREBASE_ENV: GcpIapEnv = {
  CAELO_PROVIDER: "gcp-firebase",
  K_SERVICE: "caelo-production-admin-abc",
  CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@p.iam.gserviceaccount.com",
};
const IAP =
  "https://iap.googleapis.com/v1/projects/p/iap_web/cloud_run-europe-west1/services/caelo-production-admin-abc";
const SA =
  "https://iam.googleapis.com/v1/projects/-/serviceAccounts/caelo-mcp%40p.iam.gserviceaccount.com";

const sets = (calls: Call[]) => calls.filter((c) => c.url.endsWith(":setIamPolicy"));

describe("gcpIapBackendFromEnv", () => {
  it("is a no-op (null) on installs without Google IAP", () => {
    for (const provider of [undefined, "self-hosted", "aws", "azure"]) {
      expect(gcpIapBackendFromEnv({ CAELO_PROVIDER: provider })).toBeNull();
    }
  });

  it("gcp-firebase: allows the user on the Cloud Run IAP resource and on the MCP SA, as the admin", async () => {
    const { deps, calls } = fakeGoogle((c) =>
      c.url === `${IAP}:getIamPolicy`
        ? {
            status: 200,
            body: {
              etag: "e1",
              bindings: [{ role: IAP_ACCESSOR_ROLE, members: ["user:owner@x.com"] }],
            },
          }
        : undefined,
    );
    const backend = gcpIapBackendFromEnv(FIREBASE_ENV, deps);
    await backend?.setAccess("user:new@x.com", true);

    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${IAP}:getIamPolicy`,
      `POST ${IAP}:setIamPolicy`,
      `POST ${SA}:getIamPolicy?options.requestedPolicyVersion=3`,
      `POST ${SA}:setIamPolicy`,
    ]);
    expect(sets(calls).map((c) => c.body)).toEqual([
      {
        policy: {
          etag: "e1",
          bindings: [{ role: IAP_ACCESSOR_ROLE, members: ["user:owner@x.com", "user:new@x.com"] }],
        },
      },
      { policy: { bindings: [{ role: TOKEN_CREATOR_ROLE, members: ["user:new@x.com"] }] } },
    ]);
  });

  it("revoking someone who has no access writes nothing", async () => {
    const { deps, calls } = fakeGoogle();
    await gcpIapBackendFromEnv(FIREBASE_ENV, deps)?.setAccess("user:gone@x.com", false);
    expect(sets(calls)).toEqual([]);
  });

  it("gcp: finds the single IAP-enabled admin backend service and targets it", async () => {
    const { deps, calls } = fakeGoogle((c) =>
      c.url.includes("/backendServices?")
        ? {
            status: 200,
            body: {
              items: [
                { name: "caelo-production-admin-backend-1a2b3c4", iap: { enabled: true } },
                { name: "caelo-production-admin-backend-old", iap: { enabled: false } },
              ],
            },
          }
        : undefined,
    );
    const backend = gcpIapBackendFromEnv(
      { ...FIREBASE_ENV, CAELO_PROVIDER: "gcp", CAELO_ENV: "production" },
      deps,
    );
    await backend?.setAccess("user:new@x.com", true);
    expect(decodeURIComponent(calls[0]?.url ?? "")).toBe(
      "https://compute.googleapis.com/compute/v1/projects/p/global/backendServices?filter=name eq caelo-production-admin-backend.*",
    );
    expect(calls[1]?.url).toBe(
      "https://iap.googleapis.com/v1/projects/p/iap_web/compute/services/caelo-production-admin-backend-1a2b3c4:getIamPolicy",
    );
  });

  it("gcp: refuses to guess when the backend is missing or ambiguous", async () => {
    const { deps } = fakeGoogle((c) =>
      c.url.includes("/backendServices?") ? { status: 200, body: {} } : undefined,
    );
    const backend = gcpIapBackendFromEnv({ ...FIREBASE_ENV, CAELO_PROVIDER: "gcp" }, deps);
    await expect(backend?.setAccess("user:new@x.com", true)).rejects.toThrow(
      /exactly one IAP-enabled backend service/,
    );
  });

  it("a 403 points at `cms-provision upgrade` (install predates the admin's grants)", async () => {
    const { deps } = fakeGoogle((c) =>
      c.url.endsWith(":setIamPolicy") ? { status: 403, body: { error: "denied" } } : undefined,
    );
    const err = await gcpIapBackendFromEnv(FIREBASE_ENV, deps)
      ?.setAccess("user:new@x.com", true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperatorAccessError);
    expect((err as OperatorAccessError).nextStep).toContain("cms-provision upgrade");
  });

  it("a non-Google email is explained as such", async () => {
    const { deps } = fakeGoogle((c) =>
      c.url.endsWith(":setIamPolicy")
        ? { status: 400, body: { error: { message: "User new@corp.example does not exist." } } }
        : undefined,
    );
    const err = (await gcpIapBackendFromEnv(FIREBASE_ENV, deps)
      ?.setAccess("user:new@corp.example", true)
      .catch((e: unknown) => e)) as OperatorAccessError;
    expect(err.nextStep).toContain("Google account");
  });

  it("retries on a concurrent policy edit (etag conflict)", async () => {
    let conflicts = 1;
    const { deps, calls } = fakeGoogle((c) => {
      if (c.url === `${IAP}:setIamPolicy` && conflicts > 0) {
        conflicts--;
        return { status: 409, body: { error: "etag" } };
      }
      return undefined;
    });
    await gcpIapBackendFromEnv(FIREBASE_ENV, deps)?.setAccess("user:new@x.com", true);
    expect(calls.filter((c) => c.url === `${IAP}:setIamPolicy`)).toHaveLength(2);
  });

  it("without the MCP service account env it fails before changing anything", async () => {
    const { deps, calls } = fakeGoogle();
    const backend = gcpIapBackendFromEnv(
      { ...FIREBASE_ENV, CAELO_MCP_IAP_SERVICE_ACCOUNT: undefined },
      deps,
    );
    await expect(backend?.setAccess("user:new@x.com", true)).rejects.toThrow(
      /CAELO_MCP_IAP_SERVICE_ACCOUNT/,
    );
    expect(calls).toEqual([]);
  });
});
