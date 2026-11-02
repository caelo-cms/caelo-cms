// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the MCP-Auth-Proxy's request order (server.ts): health always,
 * the interim forwarder on gcp-firebase, the fixed 404 while remote MCP is
 * unavailable, off or not asked for, then the router — and no database
 * anywhere on the way.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTERIM_FORWARDED_HOST_HEADER,
  JSON_SECURITY_HEADERS,
  TRUSTED_PROXY_HOPS_ENV,
} from "@caelo-cms/shared";
import { BASE_ENV, CONFIGURED_FILE, PUBLIC } from "./__tests__/harness.js";
import {
  createProxyHandler,
  INTERIM_FORWARD_ORIGIN_ENV,
  interimForwardHeaders,
  REMOTE_MCP_ENV,
  remoteMcpModeFromEnv,
} from "./server.js";

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

  it("refuses a forward origin that is not a bare https origin", () => {
    for (const bad of [`${DATA_GATEWAY}/`, "http://gw.example.com", "not a url"]) {
      expect(() =>
        createProxyHandler({ env: configuredEnv({ [INTERIM_FORWARD_ORIGIN_ENV]: bad }) }),
      ).toThrow(/CAELO_INTERIM_FORWARD_ORIGIN/);
    }
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

describe("interim forwarder (FIXME #1331, gcp-firebase)", () => {
  interface Seen {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }

  function forwarding(): { handler: ReturnType<typeof createProxyHandler>; seen: Seen[] } {
    const seen: Seen[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? await new Response(init.body).text() : "";
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body,
      });
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("from the gateway", { status: 201, headers });
    }) as typeof fetch;
    const handler = createProxyHandler({
      env: configuredEnv({ [INTERIM_FORWARD_ORIGIN_ENV]: DATA_GATEWAY }),
      fetchImpl,
    });
    return { handler, seen };
  }

  it("streams the live /api rewrite and the staging host to the data gateway unchanged", async () => {
    const { handler, seen } = forwarding();
    const res = await handler(
      new Request("https://staging.example.com/api/plugin/forms/submit?x=1", {
        method: "POST",
        body: '{"a":1}',
        headers: {
          host: "staging.example.com",
          "content-type": "application/json",
          cookie: "caelo_staging=t",
          authorization: "Basic abc",
          "x-forwarded-for": "6.6.6.6",
          "x-caelo-mcp-client": "forged",
          forwarded: "for=6.6.6.6",
          connection: "keep-alive",
        },
      }),
      PEER,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("from the gateway");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    // The data gateway's answer, not the proxy's: passed through untouched.
    expect(res.headers.get("x-frame-options")).toBeNull();
    const [up] = seen;
    expect(up?.url).toBe(`${DATA_GATEWAY}/api/plugin/forms/submit?x=1`);
    expect(up?.method).toBe("POST");
    expect(up?.body).toBe('{"a":1}');
    expect(up?.headers.get(INTERIM_FORWARDED_HOST_HEADER)).toBe("staging.example.com");
    expect(up?.headers.get("cookie")).toBe("caelo_staging=t");
    expect(up?.headers.get("authorization")).toBe("Basic abc");
    for (const stripped of [
      "host",
      "x-forwarded-for",
      "x-caelo-mcp-client",
      "forwarded",
      "connection",
    ]) {
      expect(up?.headers.get(stripped)).toBeNull();
    }
  });

  it("does not forward remote MCP on its own host", async () => {
    const { handler, seen } = forwarding();
    const res = await handler(new Request(`${PUBLIC}/api/mcp/oauth/status`), PEER);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { configured: boolean }).configured).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("forwards an MCP path on another host (the staging host is not the broker's origin)", async () => {
    const { handler, seen } = forwarding();
    await handler(
      new Request("https://staging.example.com/api/mcp/oauth/authorize", {
        headers: { host: "staging.example.com" },
      }),
      PEER,
    );
    expect(seen).toHaveLength(1);
  });

  it("keeps answering health itself", async () => {
    const { handler, seen } = forwarding();
    const res = await handler(new Request("https://staging.example.com/api/mcp/health"), PEER);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it("strips a client's own forwarded-host claim before setting it", () => {
    const headers = interimForwardHeaders(
      new Request(`${PUBLIC}/x`, {
        headers: { host: "staging.example.com", [INTERIM_FORWARDED_HOST_HEADER]: "evil.example" },
      }),
    );
    expect(headers.get(INTERIM_FORWARDED_HOST_HEADER)).toBe("staging.example.com");
  });
});
