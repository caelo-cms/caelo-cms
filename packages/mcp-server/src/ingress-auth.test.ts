// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createIngressAuth, describeIapRejection, iapAudience } from "./ingress-auth.js";

const SA = "caelo-mcp@viu-one-web.iam.gserviceaccount.com";
const ADMIN = "https://caelo-production-admin-abc-ew.a.run.app";

function fakeSignJwt() {
  const calls: { url: string; auth: string; payload: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const payload = JSON.parse(JSON.parse(String(init.body)).payload);
    calls.push({ url, auth: headers.authorization ?? "", payload });
    return new Response(JSON.stringify({ keyId: "k", signedJwt: `jwt-${calls.length}` }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("createIngressAuth", () => {
  it("is off unless CAELO_IAP_SERVICE_ACCOUNT is set (non-GCP installs unchanged)", () => {
    expect(createIngressAuth({ CAELO_ADMIN_URL: ADMIN })).toBeNull();
    expect(
      createIngressAuth({ CAELO_ADMIN_URL: ADMIN, CAELO_IAP_SERVICE_ACCOUNT: "  " }),
    ).toBeNull();
  });

  it("signs a service-account JWT for the admin origin via IAM Credentials signJwt", async () => {
    const { fetchFn, calls } = fakeSignJwt();
    const ingress = createIngressAuth(
      { CAELO_ADMIN_URL: `${ADMIN}/`, CAELO_IAP_SERVICE_ACCOUNT: SA },
      { fetch: fetchFn, getAccessToken: async () => "adc-token", now: () => 1_000 },
    );
    expect(await ingress?.headers()).toEqual({ authorization: "Bearer jwt-1" });
    expect(calls[0]?.url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`,
    );
    expect(calls[0]?.auth).toBe("Bearer adc-token");
    expect(calls[0]?.payload).toEqual({
      iss: SA,
      sub: SA,
      aud: `${ADMIN}/*`,
      iat: 1_000,
      exp: 4_600,
    });
  });

  it("reuses the JWT until a minute before expiry, then mints a new one", async () => {
    const { fetchFn, calls } = fakeSignJwt();
    let t = 1_000;
    const ingress = createIngressAuth(
      { CAELO_ADMIN_URL: ADMIN, CAELO_IAP_SERVICE_ACCOUNT: SA },
      { fetch: fetchFn, getAccessToken: async () => "adc", now: () => t },
    );
    await ingress?.headers();
    t = 1_000 + 3_500;
    expect(await ingress?.headers()).toEqual({ authorization: "Bearer jwt-1" });
    t = 1_000 + 3_541;
    expect(await ingress?.headers()).toEqual({ authorization: "Bearer jwt-2" });
    expect(calls).toHaveLength(2);
  });

  it("mints once for concurrent first calls", async () => {
    const { fetchFn, calls } = fakeSignJwt();
    const ingress = createIngressAuth(
      { CAELO_ADMIN_URL: ADMIN, CAELO_IAP_SERVICE_ACCOUNT: SA },
      { fetch: fetchFn, getAccessToken: async () => "adc", now: () => 1 },
    );
    await Promise.all([ingress?.headers(), ingress?.headers(), ingress?.headers()]);
    expect(calls).toHaveLength(1);
  });

  it("explains a missing token-creator grant", async () => {
    const ingress = createIngressAuth(
      { CAELO_ADMIN_URL: ADMIN, CAELO_IAP_SERVICE_ACCOUNT: SA },
      {
        fetch: (async () =>
          new Response("PERMISSION_DENIED", { status: 403 })) as unknown as typeof fetch,
        getAccessToken: async () => "adc",
      },
    );
    await expect(ingress?.headers()).rejects.toThrow(/serviceAccountTokenCreator/);
  });

  it("explains missing Application Default Credentials", async () => {
    const ingress = createIngressAuth(
      { CAELO_ADMIN_URL: ADMIN, CAELO_IAP_SERVICE_ACCOUNT: SA },
      {
        getAccessToken: async () => {
          throw new Error("Could not load the default credentials");
        },
      },
    );
    await expect(ingress?.headers()).rejects.toThrow(/gcloud auth application-default login/);
  });
});

describe("iapAudience", () => {
  it("is the origin with a path wildcard", () => {
    expect(iapAudience("https://admin.viu.one/security/mcp")).toBe("https://admin.viu.one/*");
  });
});

describe("describeIapRejection", () => {
  const iapResponse = new Response("", {
    status: 401,
    headers: { "x-goog-iap-generated-response": "true" },
  });

  it("names the fix when IAP rejects an unconfigured shim (regression: bare 'empty token')", () => {
    const prev = process.env.CAELO_IAP_SERVICE_ACCOUNT;
    delete process.env.CAELO_IAP_SERVICE_ACCOUNT;
    try {
      const msg = describeIapRejection(iapResponse, "Invalid IAP credentials: empty token");
      expect(msg).toContain("protected by Google IAP");
      expect(msg).toContain("/security/mcp");
    } finally {
      if (prev !== undefined) process.env.CAELO_IAP_SERVICE_ACCOUNT = prev;
    }
  });

  it("leaves Caelo's own errors alone", () => {
    expect(describeIapRejection(new Response("", { status: 401 }), "bad token")).toBeNull();
  });
});
