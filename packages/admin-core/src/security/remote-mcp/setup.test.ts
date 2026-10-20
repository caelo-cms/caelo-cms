// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — Settings → MCP → Remote: availability per install and the broker's
 * self-check lines (no real gateway). The sign-in client itself is set up
 * under Settings → Google sign-in (#914, google-sign-in/setup.test.ts).
 */

import { describe, expect, it } from "bun:test";
import type { SelfCheckDeps } from "../google-sign-in/setup.js";
import {
  checkAuthorizationServer,
  checkGatewayClient,
  remoteMcpAvailability,
  runRemoteMcpSelfCheck,
} from "./setup.js";

const PUBLIC = "https://caelo-production-gateway-bbb-xyz.a.run.app";
const CLIENT = "123456789012-abc123.apps.googleusercontent.com";
const ENV = {
  CAELO_PROVIDER: "gcp-firebase",
  CAELO_MCP_PUBLIC_URL: PUBLIC,
  CAELO_IAP_AUDIENCE: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
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
      missing: ["CAELO_MCP_PUBLIC_URL", "CAELO_IAP_AUDIENCE"],
    });
    expect(a.status === "needs-upgrade" && a.nextStep).toContain("cms-provision upgrade");
    const bad = remoteMcpAvailability({ ...ENV, CAELO_MCP_PUBLIC_URL: "http://x/" });
    expect(bad).toMatchObject({ status: "needs-upgrade", missing: ["CAELO_MCP_PUBLIC_URL"] });
  });

  it("derives both MCP URLs and points at Google sign-in for the client", () => {
    expect(remoteMcpAvailability(ENV)).toEqual({
      status: "available",
      mcpPublicUrl: PUBLIC,
      signInSettingsPath: "/settings/google-sign-in",
      urls: { chat: `${PUBLIC}/api/mcp/chat`, admin: `${PUBLIC}/api/mcp/admin` },
    });
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

  it("runs the broker chain in order, and only the gateway's 'off' without a client", async () => {
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
    const lines = await runRemoteMcpSelfCheck(on, { mcpPublicUrl: PUBLIC, clientId: CLIENT });
    expect(lines.map((l) => [l.id, l.ok])).toEqual([
      ["gateway-client", true],
      ["authorization-server", true],
      ["protected-resource", true],
    ]);

    const off = gateway({ "/api/mcp/oauth/status": () => ({ configured: false }) });
    const offLines = await runRemoteMcpSelfCheck(off, { mcpPublicUrl: PUBLIC, clientId: null });
    expect(offLines.map((l) => [l.id, l.ok])).toEqual([["gateway-client", true]]);
  });
});
