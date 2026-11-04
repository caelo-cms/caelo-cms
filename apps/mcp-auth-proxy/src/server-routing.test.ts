// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the MCP-Auth-Proxy's request order (server.ts): health always,
 * the fixed 404 while remote MCP is unavailable, off or not asked for, then
 * the router — and no database anywhere on the way, nothing forwarded
 * elsewhere (#1331).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSON_SECURITY_HEADERS, TRUSTED_PROXY_HOPS_ENV } from "@caelo-cms/shared";
import { BASE_ENV, CONFIGURED_FILE, PUBLIC } from "./__tests__/harness.js";
import { createProxyHandler, REMOTE_MCP_ENV, remoteMcpModeFromEnv } from "./server.js";

const PEER = { peerAddress: "198.51.100.7" };
const DATA_GATEWAY = "https://caelo-production-data-gateway-abc-ew.a.run.app";
const OFF = { error: "not_found", configured: false };

function clientFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "caelo-mcp-")), "client.json");
  writeFileSync(file, content);
  return file;
}

/** Env of a configured gcp install (remote MCP available, client set up). */
function configuredEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...BASE_ENV,
    CAELO_OPERATOR_OAUTH_CLIENT_FILE: clientFile(CONFIGURED_FILE),
    [REMOTE_MCP_ENV]: "available",
    [TRUSTED_PROXY_HOPS_ENV]: "0",
    ...extra,
  };
}

describe("CAELO_REMOTE_MCP", () => {
  it("refuses to start without a valid mode", () => {
    expect(() => remoteMcpModeFromEnv({})).toThrow(/CAELO_REMOTE_MCP is not set/);
    expect(() => remoteMcpModeFromEnv({ [REMOTE_MCP_ENV]: "on" })).toThrow(/"on"/);
    expect(() => createProxyHandler({ env: { ...BASE_ENV } })).toThrow(/CAELO_REMOTE_MCP/);
  });
});

describe("request order", () => {
  it("answers health on every provider, feature on or off", async () => {
    const handler = createProxyHandler({ env: { [REMOTE_MCP_ENV]: "unavailable" } });
    for (const path of ["/healthz", "/api/mcp/health"]) {
      const res = await handler(new Request(`${PUBLIC}${path}`), PEER);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  it("answers the fixed 404 for everything while remote MCP is unavailable", async () => {
    const handler = createProxyHandler({ env: { [REMOTE_MCP_ENV]: "unavailable" } });
    for (const path of ["/api/mcp/chat", "/api/mcp/oauth/status", "/", "/api/plugin/x/y"]) {
      const res = await handler(new Request(`${PUBLIC}${path}`, { method: "POST" }), PEER);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(OFF);
    }
  });

  it("gives its own JSON answers the JSON security headers (#1326 L2)", async () => {
    const handler = createProxyHandler({ env: { [REMOTE_MCP_ENV]: "unavailable" } });
    for (const path of ["/api/mcp/health", "/api/mcp/chat"]) {
      const res = await handler(new Request(`${PUBLIC}${path}`), PEER);
      for (const [name, value] of Object.entries(JSON_SECURITY_HEADERS)) {
        expect(res.headers.get(name)).toBe(value);
      }
    }
  });

  it("answers the fixed 404 while the Owner has not set up Google sign-in", async () => {
    const handler = createProxyHandler({
      env: configuredEnv({ CAELO_OPERATOR_OAUTH_CLIENT_FILE: clientFile("{}") }),
    });
    for (const path of ["/api/mcp/chat", "/api/mcp/oauth/status"]) {
      const res = await handler(new Request(`${PUBLIC}${path}`, { method: "POST" }), PEER);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(OFF);
    }
  });

  it("answers the fixed 404 for a path that is not remote MCP", async () => {
    const handler = createProxyHandler({ env: configuredEnv() });
    const res = await handler(new Request(`${PUBLIC}/api/plugin/forms/submit`), PEER);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(OFF);
  });

  it("serves remote MCP once configured", async () => {
    const handler = createProxyHandler({ env: configuredEnv() });
    const meta = await handler(
      new Request(`${PUBLIC}/.well-known/oauth-authorization-server/api/mcp/oauth`),
      PEER,
    );
    expect(meta.status).toBe(200);
    const status = await handler(new Request(`${PUBLIC}/api/mcp/oauth/status`), PEER);
    expect(((await status.json()) as { configured: boolean }).configured).toBe(true);
    const chat = await handler(new Request(`${PUBLIC}/api/mcp/chat`, { method: "POST" }), PEER);
    expect(chat.status).toBe(401);
  });

  it("answers the structured 503 when the install lacks the MCP env", async () => {
    const handler = createProxyHandler({
      env: { [REMOTE_MCP_ENV]: "available", [TRUSTED_PROXY_HOPS_ENV]: "0" },
    });
    const res = await handler(new Request(`${PUBLIC}/api/mcp/chat`, { method: "POST" }), PEER);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("remote_mcp_not_configured");
  });

  it("refuses to serve without knowing the client address (no guessed bucket)", async () => {
    const env = configuredEnv();
    delete env[TRUSTED_PROXY_HOPS_ENV];
    const handler = createProxyHandler({ env });
    const res = await handler(new Request(`${PUBLIC}/api/mcp/oauth/status`), PEER);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("ClientAddressUnavailable");
  });
});

describe("no forwarding (#1331)", () => {
  it("answers the fixed 404 for visitor and staging traffic instead of passing it on", async () => {
    // Until #1331 the gcp-firebase proxy streamed the old /api/** rewrite and
    // the staging domain mapping to the data gateway. Both are gone: the
    // live rewrite names the data gateway (#1380), the staging host is the
    // staging gateway's (#1330). A leftover env var forwards nothing.
    const handler = createProxyHandler({
      env: configuredEnv({ CAELO_INTERIM_FORWARD_ORIGIN: DATA_GATEWAY }),
    });
    for (const url of [
      "https://staging.example.com/",
      "https://staging.example.com/api/plugin/forms/submit",
      `${PUBLIC}/api/plugin/forms/submit`,
    ]) {
      const res = await handler(new Request(url, { method: "POST", body: "{}" }), PEER);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(OFF);
    }
  });
});
