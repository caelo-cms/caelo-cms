// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — the redirect-URI allowlist is what keeps authorization codes
 * (= Google access tokens a moment later) away from attackers. Every
 * open-redirect trick here must fail.
 */

import { describe, expect, it } from "bun:test";
import {
  isAllowedRedirectUri,
  REDIRECT_URI_ALLOWLIST,
  redirectUriMatches,
} from "./redirect-allowlist.js";

describe("isAllowedRedirectUri", () => {
  it("accepts every fixed vendor callback", () => {
    for (const uri of REDIRECT_URI_ALLOWLIST) expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it("accepts ChatGPT callback ids and loopback redirects", () => {
    for (const uri of [
      "https://chatgpt.com/connector/oauth/abc_DEF-123",
      "http://127.0.0.1:33418/",
      "http://127.0.0.1/",
      "http://127.0.0.1",
      "http://localhost:3118/callback",
      "http://localhost/callback",
      "http://localhost:8787/callback",
      "http://[::1]:5000/oauth/cb",
      "http://127.0.0.1:65535/a/b/c",
    ]) {
      expect(isAllowedRedirectUri(uri)).toBe(true);
    }
  });

  it.each([
    ["unlisted host", "https://evil.example/callback"],
    ["lookalike suffix", "https://claude.ai.evil.com/api/mcp/auth_callback"],
    ["lookalike prefix", "https://evilclaude.ai/api/mcp/auth_callback"],
    ["subdomain", "https://x.claude.ai/api/mcp/auth_callback"],
    ["userinfo trick", "https://claude.ai@evil.com/api/mcp/auth_callback"],
    ["userinfo on loopback", "http://127.0.0.1@evil.com/"],
    ["userinfo before loopback", "http://evil.com@127.0.0.1:80/"],
    ["encoded slash userinfo", "https://claude.ai%2F@evil.com/api/mcp/auth_callback"],
    ["fragment", "https://claude.ai/api/mcp/auth_callback#x"],
    ["fragment on loopback", "http://127.0.0.1:1234/cb#frag"],
    ["query appended", "https://claude.ai/api/mcp/auth_callback?next=https://evil.com"],
    ["query on loopback", "http://localhost:1234/cb?x=1"],
    ["http instead of https", "http://claude.ai/api/mcp/auth_callback"],
    ["https loopback", "https://127.0.0.1:1234/cb"],
    ["host case", "https://Claude.ai/api/mcp/auth_callback"],
    ["scheme case", "HTTPS://claude.ai/api/mcp/auth_callback"],
    ["path case", "https://claude.ai/api/MCP/auth_callback"],
    ["trailing slash", "https://claude.ai/api/mcp/auth_callback/"],
    ["trailing dot host", "https://claude.ai./api/mcp/auth_callback"],
    ["explicit port", "https://claude.ai:443/api/mcp/auth_callback"],
    ["encoded path", "https://claude.ai/api/mcp/auth%5Fcallback"],
    ["path traversal", "https://claude.ai/api/mcp/../mcp/auth_callback"],
    ["chatgpt id too long", `https://chatgpt.com/connector/oauth/${"a".repeat(129)}`],
    ["chatgpt id slash", "https://chatgpt.com/connector/oauth/a/b"],
    ["chatgpt id encoded", "https://chatgpt.com/connector/oauth/a%2Fb"],
    ["chatgpt empty id", "https://chatgpt.com/connector/oauth/"],
    ["loopback lookalike", "http://127.0.0.1.evil.com/"],
    ["localhost lookalike", "http://localhost.evil.com:1234/"],
    ["other private ip", "http://10.0.0.1:1234/"],
    ["decimal ip", "http://2130706433:1234/"],
    ["port zero", "http://127.0.0.1:0/"],
    ["port too large", "http://127.0.0.1:65536/"],
    ["leading-zero port", "http://127.0.0.1:080/"],
    ["backslash", "http://127.0.0.1:1234\\@evil.com/"],
    ["encoded slash in loopback path", "http://127.0.0.1:1234/a%2F..%2Fb"],
    ["broken escape", "http://127.0.0.1:1234/a%zz"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,x"],
    ["other custom scheme", "cursor://evil/oauth/callback"],
    ["whitespace", " https://claude.ai/api/mcp/auth_callback"],
    ["newline", "https://claude.ai/api/mcp/auth_callback\n"],
    ["empty", ""],
  ])("refuses %s", (_label, uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });
});

describe("redirectUriMatches", () => {
  it("is exact for non-loopback URIs", () => {
    const reg = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", reg)).toBe(true);
    expect(redirectUriMatches("https://claude.com/api/mcp/auth_callback", reg)).toBe(false);
  });

  it("ignores the port for loopback (RFC 8252 §7.3, Claude Code's CIMD lists no port)", () => {
    const reg = ["http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriMatches("http://localhost:3118/callback", reg)).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:59656/callback", reg)).toBe(true);
    // Host and path still must match.
    expect(redirectUriMatches("http://[::1]:3118/callback", reg)).toBe(false);
    expect(redirectUriMatches("http://localhost:3118/other", reg)).toBe(false);
  });

  it("refuses a registered URI that is not on the allowlist", () => {
    expect(redirectUriMatches("https://evil.example/cb", ["https://evil.example/cb"])).toBe(false);
  });
});
