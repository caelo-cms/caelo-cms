// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — the OAuth broker end to end against a fake Google token endpoint
 * and fake CIMD hosts: metadata, DCR, CIMD, authorize, callback, token,
 * refresh, and every adversarial case the contract names.
 */

import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "../mcp/google.js";
import {
  approve,
  authorizeQuery,
  CLAUDE_REDIRECT,
  defaultGoogle,
  fakeIdToken,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  type GoogleFake,
  harness,
  ISSUER,
  location,
  obtainCode,
  openAccess,
  PUBLIC,
  pkce,
  postToken,
  registerClient,
  SEAL_KEY_B64,
} from "./__tests__/harness.js";
import { seal } from "./seal.js";
import { REFRESH_MAX_LIFETIME_SECONDS } from "./token.js";

const CLAUDE_CODE_CIMD = "https://claude.ai/oauth/claude-code-client-metadata";
const CHATGPT_CIMD = "https://chatgpt.com/oauth/client.json";

function cimdResponse(doc: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const claudeCodeDoc = {
  client_id: CLAUDE_CODE_CIMD,
  client_name: "Claude Code",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

describe("discovery metadata", () => {
  it("serves RFC 9728 metadata for both surfaces on both paths", async () => {
    const h = harness();
    for (const surface of ["chat", "admin"]) {
      for (const path of [
        `/.well-known/oauth-protected-resource/api/mcp/${surface}`,
        `/api/mcp/oauth/protected-resource/${surface}`,
      ]) {
        const res = await h.send(path);
        expect(res.status).toBe(200);
        const doc = (await res.json()) as Record<string, unknown>;
        expect(doc.resource).toBe(`${PUBLIC}/api/mcp/${surface}`);
        expect(doc.authorization_servers).toEqual([ISSUER]);
      }
    }
  });

  it("does not pose as an OpenID Provider (no openid-configuration documents)", async () => {
    const h = harness();
    expect(
      await h.router(new Request(`${PUBLIC}/.well-known/openid-configuration/api/mcp/oauth`), {
        clientAddress: "198.51.100.7",
        setIdleTimeout: () => {},
      }),
    ).toBeNull();
    const appended = await h.send("/api/mcp/oauth/.well-known/openid-configuration");
    expect(appended.status).toBe(404);
  });

  it("serves the AS metadata on both RFC 8414 variants with the contract's fields", async () => {
    const h = harness();
    for (const path of [
      "/.well-known/oauth-authorization-server/api/mcp/oauth",
      "/api/mcp/oauth/.well-known/oauth-authorization-server",
    ]) {
      const res = await h.send(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["openid", "email"],
      });
    }
  });

  it("leaves other paths to the rest of the gateway", async () => {
    const h = harness();
    for (const path of ["/api/plugin/x/y", "/.well-known/security.txt", "/api/mcpx"]) {
      expect(
        await h.router(new Request(`${PUBLIC}${path}`), {
          clientAddress: "198.51.100.7",
          setIdleTimeout: () => {},
        }),
      ).toBeNull();
    }
  });
});

describe("CORS", () => {
  it("answers preflight on the MCP, metadata, token and register endpoints", async () => {
    const h = harness({ clientFile: "{}" });
    for (const path of [
      "/api/mcp/chat",
      "/api/mcp/admin",
      "/api/mcp/oauth/token",
      "/api/mcp/oauth/register",
      "/.well-known/oauth-protected-resource/api/mcp/chat",
      "/.well-known/oauth-authorization-server/api/mcp/oauth",
    ]) {
      const res = await h.send(path, {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-method": "POST" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain("mcp-session-id");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(res.headers.get("access-control-expose-headers")).toBe(
        "mcp-session-id, www-authenticate",
      );
    }
  });
});

describe("not configured", () => {
  it("answers 503 remote_mcp_not_configured everywhere while the client file is the placeholder", async () => {
    const h = harness({ clientFile: "{}" });
    for (const [path, init] of [
      ["/api/mcp/chat", { method: "POST" }],
      ["/api/mcp/oauth/authorize", {}],
      ["/api/mcp/oauth/token", { method: "POST" }],
      ["/api/mcp/oauth/register", { method: "POST" }],
      ["/.well-known/oauth-authorization-server/api/mcp/oauth", {}],
      ["/api/mcp/oauth/protected-resource/admin", {}],
    ] as const) {
      const res = await h.send(path, init);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "remote_mcp_not_configured",
        message: "Remote MCP is not set up on this site. An Owner enables it under Settings → MCP.",
      });
    }
    const status = await h.send("/api/mcp/oauth/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: false });
  });

  it("names the missing env var instead of falling back", async () => {
    const h = harness({ env: { CAELO_ADMIN_URL: undefined, CAELO_MCP_OAUTH_SEAL_KEY: undefined } });
    for (const path of ["/api/mcp/chat", "/api/mcp/oauth/status"]) {
      const res = await h.send(path);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("remote_mcp_not_configured");
      expect(body.message).toContain("CAELO_ADMIN_URL");
      expect(body.message).toContain("CAELO_MCP_OAUTH_SEAL_KEY");
    }
  });

  it("refuses a malformed seal key, public URL or half-filled client file", async () => {
    const cases = [
      harness({ env: { CAELO_MCP_OAUTH_SEAL_KEY: Buffer.alloc(16).toString("base64") } }),
      harness({ env: { CAELO_MCP_PUBLIC_URL: `${PUBLIC}/` } }),
      harness({ env: { CAELO_MCP_PUBLIC_URL: "http://gw.example.com" } }),
      harness({ clientFile: JSON.stringify({ client_id: "x" }) }),
      harness({ clientFile: "not json" }),
      harness({ env: { CAELO_MCP_OAUTH_CLIENT_FILE: "/nowhere" } }),
    ];
    for (const h of cases) {
      const res = await h.send("/api/mcp/oauth/protected-resource/chat");
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("remote_mcp_not_configured");
      expect(text).not.toContain(GOOGLE_CLIENT_SECRET);
    }
  });

  it("reports the configured client id (never the secret) and picks up a saved client within 60 s", async () => {
    let file = "{}";
    const h = harness({ clientFile: () => file });
    expect(await (await h.send("/api/mcp/oauth/status")).json()).toEqual({ configured: false });
    file = JSON.stringify({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET });
    // Cached: still the old answer right after the save.
    expect(await (await h.send("/api/mcp/oauth/status")).json()).toEqual({ configured: false });
    h.advance(60_000);
    const body = await (await h.send("/api/mcp/oauth/status")).text();
    expect(JSON.parse(body)).toEqual({ configured: true, clientId: GOOGLE_CLIENT_ID });
    expect(body).not.toContain(GOOGLE_CLIENT_SECRET);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client for allowlisted redirect URIs", async () => {
    const h = harness();
    const res = await h.send("/api/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: "Claude" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      redirect_uris: [CLAUDE_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(body.client_id).toStartWith("v2.");
    expect(body.client_secret).toBeUndefined();
  });

  it.each([
    [
      "an unlisted redirect URI",
      { redirect_uris: ["https://evil.example/cb"] },
      "invalid_redirect_uri",
    ],
    [
      "a lookalike redirect URI",
      { redirect_uris: [CLAUDE_REDIRECT, "https://claude.ai.evil.com/api/mcp/auth_callback"] },
      "invalid_redirect_uri",
    ],
    [
      "a confidential client",
      { redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
      "invalid_client_metadata",
    ],
    ["no redirect URIs", { redirect_uris: [] }, "invalid_client_metadata"],
    [
      "an unsupported grant",
      { redirect_uris: [CLAUDE_REDIRECT], grant_types: ["client_credentials"] },
      "invalid_client_metadata",
    ],
    [
      "implicit flow",
      { redirect_uris: [CLAUDE_REDIRECT], response_types: ["token"] },
      "invalid_client_metadata",
    ],
  ])("refuses %s", async (_label, body, error) => {
    const h = harness();
    const res = await h.send("/api/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(error);
  });

  it("refuses a registration whose client_id would not fit the sealed state and code", async () => {
    const h = harness();
    const uris = Array.from(
      { length: 20 },
      (_, i) => `http://127.0.0.1:${1000 + i}/${"p".repeat(150)}`,
    );
    const res = await h.send("/api/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: uris, client_name: "x".repeat(200) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });

  it("completes a sign-in for the largest registration and client state it accepts", async () => {
    // The search below registers many times; lift the per-address limit for it.
    const roomy = { capacity: 1000, windowSeconds: 60 };
    const h = harness({
      rateLimits: {
        authorize: roomy,
        callback: roomy,
        token: roomy,
        register: roomy,
        metadata: roomy,
        proxy: roomy,
      },
    });
    // One long loopback URI, as long as still fits under the client_id cap.
    let clientId = "";
    let redirectUri = "";
    for (let len = 1500; len > 0; len -= 20) {
      redirectUri = `http://127.0.0.1:4000/${"p".repeat(len)}`;
      const res = await h.send("/api/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "x".repeat(200) }),
      });
      if (res.status === 201) {
        clientId = ((await res.json()) as { client_id: string }).client_id;
        break;
      }
    }
    expect(clientId.length).toBeGreaterThan(1900);
    const { code } = await obtainCode(h, {
      clientId,
      redirectUri,
      challenge: pkce().challenge,
      state: "s".repeat(1024),
    });
    expect(code).toStartWith("v2.");
  });

  it("refuses non-JSON and oversized bodies", async () => {
    const h = harness();
    expect(
      (
        await h.send("/api/mcp/oauth/register", {
          method: "POST",
          body: "redirect_uris=x",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
      ).status,
    ).toBe(400);
    const big = JSON.stringify({
      redirect_uris: [CLAUDE_REDIRECT],
      client_name: "x".repeat(20_000),
    });
    expect(
      (
        await h.send("/api/mcp/oauth/register", {
          method: "POST",
          body: big,
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(413);
  });
});

describe("authorize", () => {
  it("after consent, redirects to Google with the client's challenge and a sealed state", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { challenge } = pkce();
    const { google: g } = await approve(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state-xyz",
      scope: "openid email",
      resource: `${PUBLIC}/api/mcp/chat`,
    });
    expect(`${g.origin}${g.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(Object.fromEntries(g.searchParams)).toMatchObject({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${PUBLIC}/api/mcp/oauth/google-callback`,
      response_type: "code",
      scope: "openid email",
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const state = g.searchParams.get("state") ?? "";
    expect(state).toStartWith("v2.");
    expect(state).not.toContain("client-state-xyz");
    expect(g.searchParams.has("client_secret")).toBe(false);
  });

  it.each([
    ["an unlisted redirect_uri", "https://evil.example/cb"],
    ["a lookalike host", "https://claude.ai.evil.com/api/mcp/auth_callback"],
    ["a userinfo trick", "https://claude.ai@evil.com/api/mcp/auth_callback"],
    ["a fragment", `${CLAUDE_REDIRECT}#x`],
    ["http instead of https", "http://claude.ai/api/mcp/auth_callback"],
    ["a case trick", "https://CLAUDE.AI/api/mcp/auth_callback"],
    ["an encoding trick", "https://claude.ai/api/mcp/auth%5Fcallback"],
    [
      "an allowlisted URI the client did not register",
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ],
  ])("never redirects to %s", async (_label, redirectUri) => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const res = await h.send(
      authorizeQuery({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a forged or wrong-purpose client_id without redirecting", async () => {
    const h = harness();
    const { googleState } = await obtainCode(h, {
      clientId: await registerClient(h, [CLAUDE_REDIRECT]),
      redirectUri: CLAUDE_REDIRECT,
      challenge: pkce().challenge,
    });
    for (const clientId of ["v1.AAAA.BBBB", "my-client", googleState]) {
      const res = await h.send(
        authorizeQuery({
          response_type: "code",
          client_id: clientId,
          redirect_uri: CLAUDE_REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
        }),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it.each([
    [
      "missing PKCE",
      { code_challenge: undefined, code_challenge_method: undefined },
      "invalid_request",
    ],
    ["no method (plain by default)", { code_challenge_method: undefined }, "invalid_request"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["a malformed challenge", { code_challenge: "short" }, "invalid_request"],
    // 43–128 chars is the verifier's range, not an S256 challenge's (exactly 43, base64url).
    ["a 44-character challenge", { code_challenge: "A".repeat(44) }, "invalid_request"],
    ["a 128-character challenge", { code_challenge: "A".repeat(128) }, "invalid_request"],
    ["a challenge outside base64url", { code_challenge: `${"A".repeat(42)}~` }, "invalid_request"],
    ["response_type token", { response_type: "token" }, "unsupported_response_type"],
    ["a foreign resource", { resource: "https://evil.example/api/mcp/chat" }, "invalid_target"],
  ])("redirects %s back as an error with iss and state", async (_label, over, error) => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const res = await h.send(
      authorizeQuery({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        state: "s1",
        ...over,
      }),
    );
    expect(res.status).toBe(302);
    const loc = location(res);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(loc.searchParams.get("error")).toBe(error);
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.has("code")).toBe(false);
  });

  it("refuses repeated parameters", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const q = `client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}&redirect_uri=${encodeURIComponent("https://evil.example/")}`;
    const res = await h.send(`/api/mcp/oauth/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("Client ID Metadata Documents", () => {
  it("runs Claude Code's flow with a loopback redirect on any port", async () => {
    const h = harness({
      other: (url) => {
        expect(url).toBe(CLAUDE_CODE_CIMD);
        return cimdResponse(claudeCodeDoc);
      },
    });
    const { verifier, challenge } = pkce();
    const redirectUri = "http://localhost:3118/callback";
    const { code, clientRedirect } = await obtainCode(h, {
      clientId: CLAUDE_CODE_CIMD,
      redirectUri,
      challenge,
    });
    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(redirectUri);
    const cimdCall = h.calls.find((c) => c.url === CLAUDE_CODE_CIMD);
    expect(cimdCall?.init.redirect).toBe("manual");
    expect(cimdCall?.init.signal).toBeInstanceOf(AbortSignal);
    const tok = await postToken(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLAUDE_CODE_CIMD,
      code_verifier: verifier,
    });
    expect(tok.status).toBe(200);
  });

  it("caches a fetched document briefly instead of fetching it per request", async () => {
    const h = harness({ other: () => cimdResponse(claudeCodeDoc) });
    const query = authorizeQuery({
      response_type: "code",
      client_id: CLAUDE_CODE_CIMD,
      redirect_uri: "http://localhost:3118/callback",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect((await h.send(query)).status).toBe(200);
    expect((await h.send(query)).status).toBe(200);
    expect(h.calls.filter((c) => c.url === CLAUDE_CODE_CIMD)).toHaveLength(1);
    h.advance(5 * 60 * 1000);
    expect((await h.send(query)).status).toBe(200);
    expect(h.calls.filter((c) => c.url === CLAUDE_CODE_CIMD)).toHaveLength(2);
  });

  it("accepts ChatGPT's document (it lists private_key_jwt among its methods)", async () => {
    const h = harness({
      other: () =>
        cimdResponse({
          client_id: CHATGPT_CIMD,
          redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
          jwks_uri: "https://chatgpt.com/oauth/jwks.json",
        }),
    });
    const { google } = await approve(h, {
      response_type: "code",
      client_id: CHATGPT_CIMD,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect(google.origin).toBe("https://accounts.google.com");
  });

  it.each([
    ["a non-allowlisted host", "https://evil.example/client.json"],
    ["a subdomain of an allowed host", "https://x.claude.ai/client.json"],
    ["a lookalike host", "https://claude.ai.evil.com/client.json"],
    ["userinfo", "https://claude.ai@evil.com/client.json"],
    ["an explicit port", "https://claude.ai:8443/client.json"],
    ["a non-canonical form", "https://CLAUDE.ai/oauth/claude-code-client-metadata"],
    ["a query", "https://claude.ai/client.json?x=1"],
    ["an internal address", "https://169.254.169.254/latest/meta-data"],
  ])("never fetches a CIMD on %s", async (_label, clientId) => {
    const h = harness({ other: () => cimdResponse({}) });
    const res = await h.send(
      authorizeQuery({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    ],
    ["an error status", () => new Response("nope", { status: 404 })],
    [
      "a non-JSON type",
      () =>
        new Response(JSON.stringify(claudeCodeDoc), { headers: { "content-type": "text/html" } }),
    ],
    ["an oversized document", () => cimdResponse({ ...claudeCodeDoc, pad: "x".repeat(70_000) })],
    [
      "an oversized declared length",
      () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "999999" },
        }),
    ],
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    [
      "a different client_id",
      () => cimdResponse({ ...claudeCodeDoc, client_id: "https://claude.ai/other" }),
    ],
    [
      "only unlisted redirect URIs",
      () => cimdResponse({ ...claudeCodeDoc, redirect_uris: ["https://evil.example/cb"] }),
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("refuses a CIMD answering with %s", async (_label, answer) => {
    const h = harness({ other: answer });
    const res = await h.send(
      authorizeQuery({
        response_type: "code",
        client_id: CLAUDE_CODE_CIMD,
        redirect_uri: "http://localhost:3118/callback",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a redirect_uri the document does not list, even if allowlisted", async () => {
    const h = harness({ other: () => cimdResponse(claudeCodeDoc) });
    const res = await h.send(
      authorizeQuery({
        response_type: "code",
        client_id: CLAUDE_CODE_CIMD,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("gives up on a CIMD host that does not answer within 5 s", async () => {
    const h = harness({
      other: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const started = Date.now();
    const res = await h.send(
      authorizeQuery({
        response_type: "code",
        client_id: CLAUDE_CODE_CIMD,
        redirect_uri: "http://localhost:3118/callback",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
    );
    expect(res.status).toBe(400);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);
});

describe("google-callback", () => {
  it("hands the client a sealed code with its state and iss", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { code, clientRedirect } = await obtainCode(h, {
      clientId,
      redirectUri: CLAUDE_REDIRECT,
      challenge: pkce().challenge,
      state: "abc",
    });
    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(clientRedirect.searchParams.get("state")).toBe("abc");
    expect(clientRedirect.searchParams.get("iss")).toBe(ISSUER);
    expect(code).toStartWith("v2.");
    expect(code).not.toContain("google-code");
  });

  it("forwards a Google error to the client with iss and state", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { googleState: state, cookie } = await approve(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      state: "s9",
    });
    for (const [googleError, expected] of [
      ["access_denied", "access_denied"],
      ["admin_policy_enforced", "server_error"],
    ]) {
      const cb = await h.send(
        `/api/mcp/oauth/google-callback?error=${googleError}&state=${encodeURIComponent(state)}`,
        { headers: { cookie } },
      );
      const loc = location(cb);
      expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_REDIRECT);
      expect(loc.searchParams.get("error")).toBe(expected as string);
      expect(loc.searchParams.get("iss")).toBe(ISSUER);
      expect(loc.searchParams.get("state")).toBe("s9");
    }
  });

  it("refuses a tampered, expired, wrong-purpose or missing state without redirecting", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { googleState, code, cookie } = await obtainCode(h, {
      clientId,
      redirectUri: CLAUDE_REDIRECT,
      challenge: pkce().challenge,
    });
    const tampered = `${googleState.slice(0, -2)}${googleState.endsWith("A") ? "B" : "A"}A`;
    const forged = seal(new Uint8Array(32), "state", {
      client_id: clientId,
      redirect_uri: "https://evil.example/",
      client_state: null,
      resource: null,
      code_challenge: pkce().challenge,
      binding_id: "0000000000000000",
      binding_nonce: "n",
      exp: 9_999_999_999,
    });
    for (const state of [tampered, code, clientId, forged, ""]) {
      const res = await h.send(
        `/api/mcp/oauth/google-callback?code=x&state=${encodeURIComponent(state)}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    h.advance(10 * 60 * 1000);
    const expired = await h.send(
      `/api/mcp/oauth/google-callback?code=x&state=${encodeURIComponent(googleState)}`,
      { headers: { cookie } },
    );
    expect(expired.status).toBe(400);
    expect(expired.headers.get("location")).toBeNull();
  });
});

describe("token: authorization_code", () => {
  async function flow() {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code, googleState } = await obtainCode(h, {
      clientId,
      redirectUri: CLAUDE_REDIRECT,
      challenge,
    });
    return { h, clientId, verifier, code, googleState };
  }

  it("exchanges at Google with the verifier and returns Google's ID token (what IAP takes) + a sealed refresh token", async () => {
    const { h, clientId, verifier, code } = await flow();
    const res = await postToken(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${PUBLIC}/api/mcp/admin`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      token_type: "Bearer",
      // From the ID token's exp, not Google's access-token expires_in (3599).
      expires_in: 3600,
    });
    // The bearer is the ID token sealed with the surface it was granted for.
    expect(openAccess(String(body.access_token), h.nowSeconds())).toEqual({
      id_token: fakeIdToken({ aud: GOOGLE_CLIENT_ID, exp: h.nowSeconds() + 3600 }),
      resource: `${PUBLIC}/api/mcp/admin`,
      exp: h.nowSeconds() + 3600,
    });
    expect(String(body.access_token)).not.toContain(".eyJ");
    expect(JSON.stringify(body)).not.toContain("ya29.");
    expect(String(body.refresh_token)).toStartWith("v2.");
    expect(String(body.refresh_token)).not.toContain("google-refresh");
    expect(body.id_token).toBeUndefined();
    const form = h.googleForms[0];
    expect(Object.fromEntries(form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "4/google-code",
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${PUBLIC}/api/mcp/oauth/google-callback`,
      code_verifier: verifier,
    });
    expect(h.calls.find((c) => c.url === GOOGLE_TOKEN_URL)?.init.redirect).toBe("manual");
  });

  it("refuses redemption by another client or another redirect_uri (Google never called)", async () => {
    const { h, clientId, verifier, code } = await flow();
    const other = await registerClient(h, [CLAUDE_REDIRECT]);
    for (const over of [
      { client_id: other },
      { redirect_uri: "https://claude.com/api/mcp/auth_callback" },
    ]) {
      const res = await postToken(h, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        ...over,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    }
    expect(h.googleForms).toHaveLength(0);
  });

  it("requires the PKCE verifier", async () => {
    const { h, clientId, code } = await flow();
    for (const verifier of [undefined, "short", "x".repeat(129)]) {
      const fields: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: clientId,
      };
      if (verifier !== undefined) fields.code_verifier = verifier;
      const res = await postToken(h, fields);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
    expect(h.googleForms).toHaveLength(0);
  });

  it("refuses a state, client_id or forged value presented as the code, and an expired code", async () => {
    const { h, clientId, verifier, code, googleState } = await flow();
    for (const bad of [googleState, clientId, "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB"]) {
      const res = await postToken(h, {
        grant_type: "authorization_code",
        code: bad,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      });
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    }
    h.advance(5 * 60 * 1000);
    const expired = await postToken(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(((await expired.json()) as { error: string }).error).toBe("invalid_grant");
    expect(h.googleForms).toHaveLength(0);
  });

  it("checks the PKCE verifier itself: a wrong one is invalid_grant and Google is never called", async () => {
    const { h, clientId, code } = await flow();
    const res = await postToken(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      // Well-formed, just not the one whose hash went to /authorize.
      code_verifier: pkce().verifier,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(h.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(0);
  });

  it("maps Google's invalid_grant (reused or revoked code) to invalid_grant and other failures to 503", async () => {
    const google = { answer: Response.json({ error: "invalid_grant" }, { status: 400 }) };
    const h = harness({ google: () => google.answer });
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(h, { clientId, redirectUri: CLAUDE_REDIRECT, challenge });
    const fields = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    const r1 = await postToken(h, fields);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toBe("invalid_grant");
    google.answer = Response.json({ error: "invalid_client" }, { status: 401 });
    const r2 = await postToken(h, fields);
    expect(r2.status).toBe(503);
    const text = await r2.text();
    expect(text).toContain("temporarily_unavailable");
    expect(text).not.toContain(GOOGLE_CLIENT_SECRET);
  });

  it.each([
    ["no ID token (openid not granted)", (now: number) => ({ id_token: undefined, now })],
    [
      "an ID token for another client",
      (now: number) => ({
        id_token: fakeIdToken({ aud: "other.apps.googleusercontent.com", exp: now + 3600 }),
      }),
    ],
    [
      "an already expired ID token",
      (now: number) => ({ id_token: fakeIdToken({ aud: GOOGLE_CLIENT_ID, exp: now }) }),
    ],
    ["a non-JWT ID token", () => ({ id_token: "not-a-jwt" })],
  ])("answers 503 (never a token IAP would refuse) when Google returns %s", async (_l, over) => {
    const h = harness({
      google: (_form, now) =>
        Response.json({
          access_token: "ya29.x",
          expires_in: 3599,
          token_type: "Bearer",
          refresh_token: "1//r",
          ...over(now),
        }),
    });
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(h, { clientId, redirectUri: CLAUDE_REDIRECT, challenge });
    const res = await postToken(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("ya29.");
  });

  it("binds the grant to its resource (RFC 8707): a different resource is invalid_target", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(h, {
      clientId,
      redirectUri: CLAUDE_REDIRECT,
      challenge,
      resource: `${PUBLIC}/api/mcp/chat`,
    });
    const fields = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    for (const resource of [`${PUBLIC}/api/mcp/admin`, "https://evil.example/api/mcp/chat"]) {
      const res = await postToken(h, { ...fields, resource });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_target");
    }
    expect(h.googleForms).toHaveLength(0);
    const ok = await postToken(h, { ...fields, resource: `${PUBLIC}/api/mcp/chat` });
    expect(ok.status).toBe(200);
  });

  it("refuses client authentication (public clients only) and wrong content types", async () => {
    const { h, clientId, verifier, code } = await flow();
    const fields = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    const withSecret = await postToken(h, { ...fields, client_secret: "s" });
    expect(withSecret.status).toBe(401);
    expect(((await withSecret.json()) as { error: string }).error).toBe("invalid_client");
    const basic = await postToken(h, fields, { authorization: "Basic eDp5" });
    expect(basic.status).toBe(401);
    const asJson = await h.send("/api/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
    expect(asJson.status).toBe(400);
    const grant = await postToken(h, { ...fields, grant_type: "client_credentials" });
    expect(((await grant.json()) as { error: string }).error).toBe("unsupported_grant_type");
    expect(h.googleForms).toHaveLength(0);
  });
});

describe("token: refresh_token", () => {
  async function tokens(opts: { resource?: string; google?: GoogleFake } = {}) {
    const h = harness(opts.google ? { google: opts.google } : {});
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(h, {
      clientId,
      redirectUri: CLAUDE_REDIRECT,
      challenge,
      ...(opts.resource ? { resource: opts.resource } : {}),
    });
    const res = await postToken(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    const body = (await res.json()) as { refresh_token: string };
    return { h, clientId, refresh: body.refresh_token, code };
  }

  it("refreshes at Google, returns the new ID token and a re-sealed refresh token", async () => {
    const { h, clientId, refresh } = await tokens();
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ expires_in: 3500 });
    expect(openAccess(String(body.access_token), h.nowSeconds())).toEqual({
      id_token: fakeIdToken({ aud: GOOGLE_CLIENT_ID, exp: h.nowSeconds() + 3500, refreshed: true }),
      // The client never named a resource: consented (and valid) for both surfaces.
      resource: null,
      exp: h.nowSeconds() + 3500,
    });
    expect(String(body.refresh_token)).toStartWith("v2.");
    expect(Object.fromEntries(h.googleForms[1] ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "1//google-refresh",
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    });
    // The re-sealed token works too.
    const again = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: String(body.refresh_token),
      client_id: clientId,
    });
    expect(again.status).toBe(200);
  });

  it("stops refreshing 30 days after the sign-in (iat), without calling Google", async () => {
    const { h, clientId, refresh } = await tokens();
    h.advance(REFRESH_MAX_LIFETIME_SECONDS * 1000 - 60_000);
    const late = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(late.status).toBe(200);
    const rolled = ((await late.json()) as { refresh_token: string }).refresh_token;
    h.advance(60_000);
    const before = h.googleForms.length;
    // Neither the original nor the token re-sealed by a refresh outlives the sign-in.
    for (const token of [refresh, rolled]) {
      const res = await postToken(h, {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    }
    expect(h.googleForms).toHaveLength(before);
  });

  it("keeps the sign-in's iat when Google rotates the refresh token", async () => {
    let n = 0;
    const { h, clientId, refresh } = await tokens({
      google: (form, now) =>
        form.get("grant_type") === "refresh_token"
          ? Response.json({
              token_type: "Bearer",
              expires_in: 3599,
              refresh_token: `1//rotated-${++n}`,
              id_token: fakeIdToken({ aud: GOOGLE_CLIENT_ID, exp: now + 3600 }),
            })
          : defaultGoogle(form, now),
    });
    h.advance(20 * 24 * 3600 * 1000);
    const rotated = (await (
      await postToken(h, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
      })
    ).json()) as { refresh_token: string };
    h.advance(11 * 24 * 3600 * 1000);
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: rotated.refresh_token,
      client_id: clientId,
    });
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses a refresh for another resource than the sign-in's (invalid_target)", async () => {
    const { h, clientId, refresh } = await tokens({ resource: `${PUBLIC}/api/mcp/chat` });
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: `${PUBLIC}/api/mcp/admin`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_target");
    const foreign = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: "https://evil.example/api/mcp/chat",
    });
    expect(((await foreign.json()) as { error: string }).error).toBe("invalid_target");
    expect(h.googleForms).toHaveLength(1);
    const same = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: `${PUBLIC}/api/mcp/chat`,
    });
    expect(same.status).toBe(200);
  });

  it("binds a resource first named at refresh from then on", async () => {
    const { h, clientId, refresh } = await tokens();
    const first = (await (
      await postToken(h, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
        resource: `${PUBLIC}/api/mcp/admin`,
      })
    ).json()) as { refresh_token: string };
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
      resource: `${PUBLIC}/api/mcp/chat`,
    });
    expect(((await res.json()) as { error: string }).error).toBe("invalid_target");
  });

  it("refuses another client's refresh token", async () => {
    const { h, refresh } = await tokens();
    const other = await registerClient(h, [CLAUDE_REDIRECT]);
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: other,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(h.googleForms).toHaveLength(1);
  });

  it("refuses a code or client_id presented as a refresh token", async () => {
    const { h, clientId, code } = await tokens();
    for (const bad of [code, clientId]) {
      const res = await postToken(h, {
        grant_type: "refresh_token",
        refresh_token: bad,
        client_id: clientId,
      });
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    }
  });

  it("returns invalid_grant when Google revoked the grant", async () => {
    let revoked = false;
    const h = harness({
      google: (form, now) =>
        revoked
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : defaultGoogle(form, now),
    });
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(h, { clientId, redirectUri: CLAUDE_REDIRECT, challenge });
    const first = (await (
      await postToken(h, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      })
    ).json()) as { refresh_token: string };
    revoked = true;
    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("seal-key rotation", () => {
  it("keeps refresh tokens sealed under the previous key working while it is configured", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(h, { clientId, redirectUri: CLAUDE_REDIRECT, challenge });
    const { refresh_token: refresh } = (await (
      await postToken(h, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      })
    ).json()) as { refresh_token: string };
    const next = randomBytes(32).toString("base64");
    const rotating = harness({
      env: { CAELO_MCP_OAUTH_SEAL_KEY: next, CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS: SEAL_KEY_B64 },
    });
    const res = await postToken(rotating, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const moved = ((await res.json()) as { refresh_token: string }).refresh_token;
    // Re-sealed under the new key: still good once the previous key is gone,
    // while a token nobody refreshed during the rotation window is not.
    const after = harness({ env: { CAELO_MCP_OAUTH_SEAL_KEY: next } });
    const kept = await postToken(after, {
      grant_type: "refresh_token",
      refresh_token: moved,
      client_id: clientId,
    });
    expect(kept.status).toBe(200);
    const done = await postToken(after, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(((await done.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses a malformed previous key instead of ignoring it", async () => {
    const h = harness({ env: { CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS: "short" } });
    const res = await h.send("/api/mcp/oauth/protected-resource/chat");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS");
  });
});
