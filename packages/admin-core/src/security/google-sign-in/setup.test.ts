// SPDX-License-Identifier: MPL-2.0

/**
 * #914 — Settings → Google sign-in: availability per install, the redirect
 * URIs, the secret write, and the self-check lines (no real Google, no real
 * IAP).
 */

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "../operator-access/google-iam.js";
import {
  addSecretVersion,
  brokerRedirectUri,
  checkAdminSignInRedirect,
  createOAuthClientConsoleUrl,
  googleSignInAvailability,
  iapRedirectUri,
  iapSyncLine,
  oauthClientFile,
  runSignInSelfCheck,
  type SelfCheckDeps,
} from "./setup.js";

const ADMIN = "https://caelo-production-admin-aaa-ew.a.run.app";
const PUBLIC = "https://caelo-production-gateway-bbb-ew.a.run.app";
const CLIENT = "123456789012-abc123.apps.googleusercontent.com";
const GOOGLE_MANAGED = "77777-managed.apps.googleusercontent.com";
const STORE = "projects/acme-site/secrets/caelo-production-operator-oauth-client";
const ENV = {
  CAELO_PROVIDER: "gcp-firebase",
  CAELO_ADMIN_URL: ADMIN,
  CAELO_MCP_PUBLIC_URL: PUBLIC,
  CAELO_OPERATOR_OAUTH_CLIENT_STORE: STORE,
  CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
};

/** A fake IAP in front of the admin: redirects signed-out visitors to Google with `clientId()`. */
function iap(clientId: () => string | null): SelfCheckDeps & { hits: number } {
  const deps = {
    hits: 0,
    fetch: (async (input: string | URL | Request) => {
      deps.hits += 1;
      expect(String(input)).toBe(`${ADMIN}/`);
      const id = clientId();
      if (!id) return new Response("ok", { status: 200 });
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(id)}&response_type=code&scope=openid+email`,
        },
      });
    }) as typeof fetch,
    sleep: async () => {},
  };
  return deps;
}

describe("googleSignInAvailability", () => {
  it("is not available off Google IAP (self-hosted, AWS, Azure)", () => {
    for (const provider of [undefined, "self-hosted", "aws", "azure"]) {
      expect(googleSignInAvailability({ ...ENV, CAELO_PROVIDER: provider }).status).toBe(
        "not-available",
      );
    }
  });

  it("asks for an upgrade, naming what is missing, on an unprepared IAP install", () => {
    const a = googleSignInAvailability({ CAELO_PROVIDER: "gcp" });
    expect(a).toMatchObject({
      status: "needs-upgrade",
      missing: ["CAELO_OPERATOR_OAUTH_CLIENT_STORE", "CAELO_ADMIN_URL", "CAELO_MCP_PUBLIC_URL"],
    });
    expect(a.status === "needs-upgrade" && a.nextStep).toContain("cms-provision upgrade");
  });

  it("derives the console links, the broker redirect URI and the organisation", () => {
    expect(googleSignInAvailability(ENV)).toEqual({
      status: "available",
      projectId: "acme-site",
      adminUrl: ADMIN,
      secretResource: STORE,
      brokerRedirectUri: `${PUBLIC}/api/mcp/oauth/google-callback`,
      createClientUrl: "https://console.cloud.google.com/auth/clients/create?project=acme-site",
      clientsUrl: "https://console.cloud.google.com/auth/clients?project=acme-site",
      audienceUrl: "https://console.cloud.google.com/auth/audience?project=acme-site",
      organisationDomains: ["acme.com"],
    });
    expect(googleSignInAvailability({ ...ENV, CAELO_GOOGLE_ORG_DOMAIN: undefined })).toMatchObject({
      organisationDomains: "unknown",
    });
    expect(createOAuthClientConsoleUrl("a b")).toContain("project=a%20b");
  });

  it("names both redirect URIs the client needs", () => {
    expect(brokerRedirectUri("https://acme.com")).toBe(
      "https://acme.com/api/mcp/oauth/google-callback",
    );
    expect(iapRedirectUri(CLIENT)).toBe(
      `https://iap.googleapis.com/v1/oauth/clientIds/${CLIENT}:handleRedirect`,
    );
  });
});

describe("the OAuth client file", () => {
  it("is the broker's JSON, or {} when removed", () => {
    expect(JSON.parse(oauthClientFile({ clientId: CLIENT, clientSecret: "GOCSPX-s" }))).toEqual({
      client_id: CLIENT,
      client_secret: "GOCSPX-s",
    });
    expect(oauthClientFile(null)).toBe("{}");
  });

  it("is written as a new Secret Manager version, base64 in the body", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const deps: GoogleDeps = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ name: "projects/1/secrets/x/versions/2" }));
      }) as typeof fetch,
      accessToken: async () => "tok",
      metadata: async () => "",
    };
    expect(await addSecretVersion(deps, STORE, "{}")).toBe("projects/1/secrets/x/versions/2");
    expect(seen).toEqual([
      {
        url: `https://secretmanager.googleapis.com/v1/${STORE}:addVersion`,
        body: { payload: { data: Buffer.from("{}").toString("base64") } },
      },
    ]);
  });
});

describe("self-check", () => {
  it("waits until IAP sends signed-out visitors to Google with our client", async () => {
    let n = 0;
    const deps = iap(() => (++n < 3 ? GOOGLE_MANAGED : CLIENT));
    const line = await checkAdminSignInRedirect(deps, ADMIN, CLIENT, null, 60_000);
    expect(line).toMatchObject({ id: "admin-sign-in", ok: true });
    expect(deps.hits).toBe(3);
  });

  it("fails with the next step while IAP keeps its Google-managed client", async () => {
    let t = 0;
    const deps = { ...iap(() => GOOGLE_MANAGED), now: () => (t += 10_000) };
    const line = await checkAdminSignInRedirect(deps, ADMIN, CLIENT, null, 30_000);
    expect(line.ok).toBe(false);
    expect(line.detail).toContain(GOOGLE_MANAGED);
    expect(line.nextStep).toContain("In production");
  });

  it("fails when the admin answers without sending anyone to Google", async () => {
    const line = await checkAdminSignInRedirect(
      iap(() => null),
      ADMIN,
      CLIENT,
      null,
      0,
    );
    expect(line.ok).toBe(false);
    expect(line.detail).toContain("HTTP 200");
  });

  it("after removal, passes once the removed client is gone from the redirect", async () => {
    const line = await checkAdminSignInRedirect(
      iap(() => GOOGLE_MANAGED),
      ADMIN,
      null,
      CLIENT,
      0,
    );
    expect(line.ok).toBe(true);
    const stale = await checkAdminSignInRedirect(
      iap(() => CLIENT),
      ADMIN,
      null,
      CLIENT,
      0,
    );
    expect(stale.ok).toBe(false);
  });

  it("runs sync then redirect, and does not wait for IAP when the sync failed", async () => {
    const ok = await runSignInSelfCheck(
      iap(() => CLIENT),
      {
        adminUrl: ADMIN,
        clientId: CLIENT,
        sync: { status: "synced", execution: "e1", logsUrl: "l" },
      },
    );
    expect(ok.map((l) => [l.id, l.ok])).toEqual([
      ["iap-sync", true],
      ["admin-sign-in", true],
    ]);
    const deps = iap(() => GOOGLE_MANAGED);
    const failed = await runSignInSelfCheck(deps, {
      adminUrl: ADMIN,
      clientId: CLIENT,
      sync: { status: "failed", error: "boom", nextStep: "fix it" },
    });
    expect(failed.map((l) => l.ok)).toEqual([false, false]);
    expect(deps.hits).toBe(1);
  });

  it("turns a failed or missing sync job into a failed line with its next step", () => {
    expect(iapSyncLine({ status: "failed", error: "boom", nextStep: "fix it" })).toMatchObject({
      ok: false,
      detail: "boom",
      nextStep: "fix it",
    });
    expect(iapSyncLine({ status: "not-applicable", reason: "no IAP" }).nextStep).toContain(
      "cms-provision upgrade",
    );
    expect(iapSyncLine({ status: "running", execution: "e", logsUrl: "u" }).ok).toBe(false);
    expect(iapSyncLine({ status: "synced", execution: "e", logsUrl: "u" }, false).label).toContain(
      "no longer",
    );
  });
});
