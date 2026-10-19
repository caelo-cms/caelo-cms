// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — the MCP proxy against a real local admin stand-in (Bun.serve):
 * the 401 challenge, header allowlisting, IAP 401/403 mapping, and SSE
 * chunks arriving before the upstream response completes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BASE_ENV, CONFIGURED_FILE, PUBLIC } from "./__tests__/harness.js";
import { createMcpRouter } from "./routes.js";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let admin: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let releaseSecondChunk: () => void = () => {};

beforeAll(() => {
  admin = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers),
        body: req.method === "POST" ? await req.text() : "",
      });
      const mode = req.headers.get("authorization")?.slice("Bearer ".length);
      if (mode === "iap-401") {
        return new Response("Invalid IAP credentials", {
          status: 401,
          headers: {
            "x-goog-iap-generated-response": "true",
            "www-authenticate": "Bearer realm=iap",
          },
        });
      }
      if (mode === "iap-403") {
        return new Response("Access denied", {
          status: 403,
          headers: { "x-goog-iap-generated-response": "true" },
        });
      }
      if (mode === "app-403") {
        return Response.json(
          { error: "not_a_caelo_user", message: "from the admin" },
          { status: 403 },
        );
      }
      if (mode === "sse") {
        const gate = new Promise<void>((r) => {
          releaseSecondChunk = r;
        });
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(enc.encode("event: message\ndata: first\n\n"));
            await gate;
            controller.enqueue(enc.encode("event: message\ndata: second\n\n"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
        });
      }
      return Response.json(
        { ok: true },
        {
          headers: {
            "mcp-session-id": "sess-1",
            "set-cookie": "GCP_IAP_UID=secret; Path=/",
            "x-admin-trace": "t1",
          },
        },
      );
    },
  });
});

afterAll(() => {
  admin.stop(true);
});

function router() {
  return createMcpRouter({
    env: { ...BASE_ENV, CAELO_ADMIN_URL: `http://127.0.0.1:${admin.port}` },
    readFile: async () => CONFIGURED_FILE,
  });
}

async function send(
  path: string,
  init: RequestInit = {},
  hooks = { disableIdleTimeout: () => {} },
) {
  seen = [];
  const res = await router()(new Request(`${PUBLIC}${path}`, init), hooks);
  if (!res) throw new Error("router declined");
  return res;
}

const CHALLENGE_CHAT = `Bearer resource_metadata="${PUBLIC}/api/mcp/oauth/protected-resource/chat"`;

describe("MCP proxy", () => {
  it("answers 401 with the resource_metadata challenge when there is no bearer token", async () => {
    for (const surface of ["chat", "admin"]) {
      const res = await send(`/api/mcp/${surface}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${PUBLIC}/api/mcp/oauth/protected-resource/${surface}"`,
      );
      expect(res.headers.get("access-control-expose-headers")).toContain("www-authenticate");
      expect(seen).toHaveLength(0);
    }
    const basic = await send("/api/mcp/chat", {
      method: "POST",
      headers: { authorization: "Basic eDp5" },
    });
    expect(basic.status).toBe(401);
    expect(basic.headers.get("www-authenticate")).toBe(`${CHALLENGE_CHAT}, error="invalid_token"`);
    expect(seen).toHaveLength(0);
  });

  it("forwards only allowlisted headers and sets fresh forwarding facts", async () => {
    let disabled = 0;
    const res = await send(
      "/api/mcp/admin?x=1",
      {
        method: "POST",
        body: '{"jsonrpc":"2.0"}',
        headers: {
          authorization: "Bearer ya29.user-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "s",
          "mcp-protocol-version": "2025-06-18",
          "last-event-id": "e1",
          "user-agent": "claude-code/2",
          "x-goog-iap-jwt-assertion": "forged.jwt.value",
          "x-goog-authenticated-user-email": "accounts.google.com:owner@example.com",
          "x-caelo-actor-id": "owner",
          "x-caelo-mcp-token": "t",
          cookie: "caelo_session=stolen",
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
          forwarded: "for=1.2.3.4;host=evil.example",
          "x-real-ip": "1.2.3.4",
          "proxy-authorization": "Basic x",
        },
      },
      { disableIdleTimeout: () => disabled++ },
    );
    expect(res.status).toBe(200);
    expect(disabled).toBe(1);
    expect(seen).toHaveLength(1);
    const up = seen[0] as Seen;
    expect(up.method).toBe("POST");
    expect(up.path).toBe("/api/mcp/remote/admin");
    expect(up.body).toBe('{"jsonrpc":"2.0"}');
    expect(up.headers.authorization).toBe("Bearer ya29.user-token");
    expect(up.headers["content-type"]).toBe("application/json");
    expect(up.headers.accept).toBe("application/json, text/event-stream");
    expect(up.headers["mcp-session-id"]).toBe("s");
    expect(up.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(up.headers["last-event-id"]).toBe("e1");
    expect(up.headers["user-agent"]).toBe("claude-code/2");
    expect(up.headers["x-forwarded-host"]).toBe("gw.example.com");
    expect(up.headers["x-forwarded-proto"]).toBe("https");
    for (const name of Object.keys(up.headers)) {
      expect(name.startsWith("x-goog-")).toBe(false);
      expect(name.startsWith("x-caelo-")).toBe(false);
    }
    for (const name of [
      "cookie",
      "x-forwarded-for",
      "forwarded",
      "x-real-ip",
      "proxy-authorization",
    ]) {
      expect(up.headers[name]).toBeUndefined();
    }
    // Response side: session id exposed, admin cookies dropped, CORS on.
    expect(res.headers.get("mcp-session-id")).toBe("sess-1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("maps IAP's 401 to a re-auth challenge and IAP's 403 to not_a_caelo_user", async () => {
    const r401 = await send("/api/mcp/chat", {
      method: "POST",
      headers: { authorization: "Bearer iap-401" },
    });
    expect(r401.status).toBe(401);
    expect(r401.headers.get("www-authenticate")).toBe(`${CHALLENGE_CHAT}, error="invalid_token"`);
    expect(r401.headers.get("x-goog-iap-generated-response")).toBeNull();

    const r403 = await send("/api/mcp/chat", {
      method: "POST",
      headers: { authorization: "Bearer iap-403" },
    });
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({
      error: "not_a_caelo_user",
      message:
        "This Google account has no access to this Caelo site. Ask the site Owner to add you under Settings → Users.",
    });

    // A 403 from the admin itself (not IAP) passes through unchanged.
    const app = await send("/api/mcp/chat", {
      method: "POST",
      headers: { authorization: "Bearer app-403" },
    });
    expect(app.status).toBe(403);
    expect(((await app.json()) as { message: string }).message).toBe("from the admin");
  });

  it("streams SSE: the first event arrives before the upstream finishes", async () => {
    const res = await send("/api/mcp/chat", {
      method: "GET",
      headers: { authorization: "Bearer sse", accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("first chunk was buffered")), 2_000),
      ),
    ]);
    expect(dec.decode(first.value)).toContain("data: first");
    // The upstream is still open (second chunk gated) — release it now.
    releaseSecondChunk();
    let rest = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value);
    }
    expect(rest).toContain("data: second");
  });

  it("answers 502 when the admin is unreachable, and 405 for other methods", async () => {
    const r = createMcpRouter({
      env: { ...BASE_ENV, CAELO_ADMIN_URL: "http://127.0.0.1:1" },
      readFile: async () => CONFIGURED_FILE,
    });
    const res = await r(
      new Request(`${PUBLIC}/api/mcp/chat`, {
        method: "POST",
        headers: { authorization: "Bearer x" },
      }),
      { disableIdleTimeout: () => {} },
    );
    if (!res) throw new Error("router declined");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("admin_unreachable");
    const put = await send("/api/mcp/chat", {
      method: "PUT",
      headers: { authorization: "Bearer x" },
    });
    expect(put.status).toBe(405);
  });
});
