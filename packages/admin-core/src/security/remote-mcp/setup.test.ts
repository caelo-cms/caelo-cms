// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — Settings → MCP → Remote: availability per install, the secret
 * write, and the self-check lines (no real Google, no real gateway).
 */

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "../operator-access/google-iam.js";
import {
  addSecretVersion,
  brokerRedirectUri,
  checkAuthorizationServer,
  checkGatewayClient,
  createOAuthClientConsoleUrl,
  iapSyncLine,
  oauthClientFile,
  remoteMcpAvailability,
  runSelfCheck,
  type SelfCheckDeps,
} from "./setup.js";

const PUBLIC = "https://caelo-production-gateway-bbb-xyz.a.run.app";
const CLIENT = "123456789012-abc123.apps.googleusercontent.com";
const ENV = {
  CAELO_PROVIDER: "gcp-firebase",
  CAELO_MCP_PUBLIC_URL: PUBLIC,
  CAELO_IAP_AUDIENCE: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
  CAELO_MCP_OAUTH_CLIENT_STORE: "projects/acme-site/secrets/caelo-production-mcp-oauth-client",
};

/** A fake gateway answering by path. */
function gateway(routes: Record<string, () => unknown>): SelfCheckDeps & { hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      hits.push(url);
      const path = url.slice(PUBLIC.length);
      const route = routes[path];
      if (!route) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(route()), { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
  };
}

describe("remoteMcpAvailability", () => {
  it("is not available off Google IAP (self-hosted, AWS, Azure)", () => {
    for (const provider of [undefined, "self-hosted", "aws", "azure"]) {
      const a = remoteMcpAvailability({ ...ENV, CAELO_PROVIDER: provider });
      expect(a.status).toBe("not-available");
    }
  });

  it("asks for an upgrade, naming what is missing, on an unprepared IAP install", () => {
    const a = remoteMcpAvailability({ CAELO_PROVIDER: "gcp" });
    expect(a).toMatchObject({
      status: "needs-upgrade",
      missing: ["CAELO_MCP_PUBLIC_URL", "CAELO_IAP_AUDIENCE", "CAELO_MCP_OAUTH_CLIENT_STORE"],
    });
    expect(a.status === "needs-upgrade" && a.nextStep).toContain("cms-provision upgrade");
    const bad = remoteMcpAvailability({ ...ENV, CAELO_MCP_PUBLIC_URL: "http://x/" });
    expect(bad).toMatchObject({ status: "needs-upgrade", missing: ["CAELO_MCP_PUBLIC_URL"] });
  });

  it("derives the console link, redirect URI and both MCP URLs on a prepared install", () => {
    expect(remoteMcpAvailability(ENV)).toEqual({
      status: "available",
      projectId: "acme-site",
      mcpPublicUrl: PUBLIC,
      secretResource: ENV.CAELO_MCP_OAUTH_CLIENT_STORE,
      redirectUri: `${PUBLIC}/api/mcp/oauth/google-callback`,
      createClientUrl: "https://console.cloud.google.com/auth/clients/create?project=acme-site",
      clientsUrl: "https://console.cloud.google.com/auth/clients?project=acme-site",
      urls: { chat: `${PUBLIC}/api/mcp/chat`, admin: `${PUBLIC}/api/mcp/admin` },
    });
    expect(brokerRedirectUri("https://acme.com")).toBe(
      "https://acme.com/api/mcp/oauth/google-callback",
    );
    expect(createOAuthClientConsoleUrl("a b")).toContain("project=a%20b");
  });
});

describe("the OAuth client file", () => {
  it("is the broker's JSON, or {} when off", () => {
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
    const name = await addSecretVersion(deps, ENV.CAELO_MCP_OAUTH_CLIENT_STORE, "{}");
    expect(name).toBe("projects/1/secrets/x/versions/2");
    expect(seen).toEqual([
      {
        url: `https://secretmanager.googleapis.com/v1/${ENV.CAELO_MCP_OAUTH_CLIENT_STORE}:addVersion`,
        body: { payload: { data: Buffer.from("{}").toString("base64") } },
      },
    ]);
  });
});

describe("self-check", () => {
  it("waits for the gateway to pick up the new client, then reports ok", async () => {
    let n = 0;
    const deps = gateway({
      "/api/mcp/oauth/status": () =>
        ++n < 3 ? { configured: false } : { configured: true, clientId: CLIENT },
    });
    const line = await checkGatewayClient(deps, PUBLIC, CLIENT, 60_000);
    expect(line.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("fails with the next step when the gateway keeps serving another client", async () => {
    let t = 0;
    const deps = {
      ...gateway({
        "/api/mcp/oauth/status": () => ({
          configured: true,
          clientId: "999-zzz.apps.googleusercontent.com",
        }),
      }),
      now: () => (t += 10_000),
    };
    const line = await checkGatewayClient(deps, PUBLIC, CLIENT, 30_000);
    expect(line).toMatchObject({ ok: false, id: "gateway-client" });
    expect(line.detail).toContain("another client");
    expect(line.nextStep).toContain("cms-provision upgrade");
  });

  it("checks the authorization-server metadata's issuer", async () => {
    const good = gateway({
      "/.well-known/oauth-authorization-server/api/mcp/oauth": () => ({
        issuer: `${PUBLIC}/api/mcp/oauth`,
      }),
    });
    expect((await checkAuthorizationServer(good, PUBLIC)).ok).toBe(true);
    const missing = gateway({});
    const line = await checkAuthorizationServer(missing, "https://acme.com");
    expect(line.ok).toBe(false);
    expect(line.nextStep).toContain("load balancer");
  });

  it("runs the chain in order and skips the endpoint checks when turning off", async () => {
    const on = gateway({
      "/api/mcp/oauth/status": () => ({ configured: true, clientId: CLIENT }),
      "/.well-known/oauth-authorization-server/api/mcp/oauth": () => ({
        issuer: `${PUBLIC}/api/mcp/oauth`,
      }),
      "/.well-known/oauth-protected-resource/api/mcp/chat": () => ({
        resource: `${PUBLIC}/api/mcp/chat`,
        authorization_servers: [`${PUBLIC}/api/mcp/oauth`],
      }),
    });
    const lines = await runSelfCheck(on, {
      mcpPublicUrl: PUBLIC,
      clientId: CLIENT,
      sync: { status: "synced", execution: "e1", logsUrl: "l" },
    });
    expect(lines.map((l) => [l.id, l.ok])).toEqual([
      ["iap-sync", true],
      ["gateway-client", true],
      ["authorization-server", true],
      ["protected-resource", true],
    ]);

    const off = gateway({ "/api/mcp/oauth/status": () => ({ configured: false }) });
    const offLines = await runSelfCheck(off, {
      mcpPublicUrl: PUBLIC,
      clientId: null,
      sync: { status: "synced", execution: "e2", logsUrl: "l" },
    });
    expect(offLines.map((l) => [l.id, l.ok])).toEqual([
      ["iap-sync", true],
      ["gateway-client", true],
    ]);
    expect(offLines[0]?.label).toContain("no longer");
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
  });
});
