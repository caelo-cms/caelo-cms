// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  constantTimeEqual,
  DEFAULT_STAGING_HEADER_NAME,
  decideStagingAccess,
  deriveStagingCredential,
  ipMatchesCidr,
  newStagingCredentialNonce,
  parseBasicAuthorization,
  parseCidr,
  readCookie,
  STAGING_SESSION_COOKIE,
  type StagingAccessRequest,
  type StagingAccessSettings,
  safeStagingNextPath,
  signStagingToken,
  verifyStagingToken,
} from "./staging-gate.js";

const SECRET = "test-gate-secret-0123456789abcdef";
const NOW = 1_800_000_000;

const OFF: StagingAccessSettings = {
  cookieEnabled: false,
  basicAuthEnabled: false,
  basicAuthUser: "crawler",
  basicAuthNonce: "nonce-basic",
  headerEnabled: false,
  headerName: DEFAULT_STAGING_HEADER_NAME,
  headerNonce: "nonce-header",
  ipAllowlist: [],
};

function req(over: Partial<StagingAccessRequest> & { headers?: Record<string, string> } = {}) {
  const headers = Object.fromEntries(
    Object.entries(over.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    cookieHeader: over.cookieHeader ?? null,
    authorizationHeader: over.authorizationHeader ?? null,
    header: (name: string) => headers[name.toLowerCase()] ?? null,
    clientIp: over.clientIp ?? null,
  } satisfies StagingAccessRequest;
}

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

describe("constantTimeEqual", () => {
  it("compares equal and unequal strings of any length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

describe("deriveStagingCredential", () => {
  it("is deterministic per (secret, kind, nonce) and 32 URL-safe chars", async () => {
    const a = await deriveStagingCredential(SECRET, "basic-auth", "n1");
    expect(a).toBe(await deriveStagingCredential(SECRET, "basic-auth", "n1"));
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("changes with the nonce (rotation), the kind and the secret", async () => {
    const a = await deriveStagingCredential(SECRET, "basic-auth", "n1");
    expect(await deriveStagingCredential(SECRET, "basic-auth", "n2")).not.toBe(a);
    expect(await deriveStagingCredential(SECRET, "header", "n1")).not.toBe(a);
    expect(await deriveStagingCredential("other-secret", "basic-auth", "n1")).not.toBe(a);
  });

  it("new nonces are random", () => {
    expect(newStagingCredentialNonce()).not.toBe(newStagingCredentialNonce());
  });
});

describe("staging tokens", () => {
  it("verifies a valid token for its purpose only", async () => {
    const t = await signStagingToken(SECRET, "open", NOW + 60);
    expect(await verifyStagingToken(SECRET, t, "open", NOW)).toBe(true);
    expect(await verifyStagingToken(SECRET, t, "session", NOW)).toBe(false);
  });

  it("rejects expired, forged, tampered and malformed tokens", async () => {
    const t = await signStagingToken(SECRET, "session", NOW + 60);
    expect(await verifyStagingToken(SECRET, t, "session", NOW + 60)).toBe(false);
    expect(await verifyStagingToken("wrong", t, "session", NOW)).toBe(false);
    const [p, , mac] = t.split(".");
    expect(await verifyStagingToken(SECRET, `${p}.${NOW + 9999}.${mac}`, "session", NOW)).toBe(
      false,
    );
    expect(await verifyStagingToken(SECRET, "session.abc.def", "session", NOW)).toBe(false);
    expect(await verifyStagingToken(SECRET, "", "session", NOW)).toBe(false);
    // A session token presented as the other purpose's link.
    const forged = t.replace(/^session/, "open");
    expect(await verifyStagingToken(SECRET, forged, "open", NOW)).toBe(false);
  });
});

describe("CIDR matching", () => {
  it("matches IPv4 ranges and host routes", () => {
    expect(ipMatchesCidr("203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(ipMatchesCidr("203.0.114.7", "203.0.113.0/24")).toBe(false);
    expect(ipMatchesCidr("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(ipMatchesCidr("203.0.113.8", "203.0.113.7/32")).toBe(false);
    expect(ipMatchesCidr("10.1.2.3", "0.0.0.0/0")).toBe(true);
    expect(ipMatchesCidr("10.1.2.3", "10.0.0.0/9")).toBe(true);
    expect(ipMatchesCidr("10.128.2.3", "10.0.0.0/9")).toBe(false);
  });

  it("matches IPv6 ranges, compressed forms and IPv4-mapped addresses", () => {
    expect(ipMatchesCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipMatchesCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipMatchesCidr("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1/128")).toBe(true);
    expect(ipMatchesCidr("::ffff:203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(ipMatchesCidr("[2001:db8::1]", "2001:db8::/48")).toBe(true);
  });

  it("never matches across families or on garbage", () => {
    expect(ipMatchesCidr("203.0.113.7", "2001:db8::/32")).toBe(false);
    expect(ipMatchesCidr("not-an-ip", "0.0.0.0/0")).toBe(false);
    expect(ipMatchesCidr("1.2.3.4", "1.2.3.4/33")).toBe(false);
    expect(ipMatchesCidr("1.2.3.256", "0.0.0.0/0")).toBe(false);
  });

  it("parseCidr validates", () => {
    expect(parseCidr("203.0.113.0/24")).not.toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("1.2.3/8")).toBeNull();
    expect(parseCidr("1.2.3.4/8/1")).toBeNull();
    expect(parseCidr("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("header parsing", () => {
  it("parses basic authorization, including colons in the password", () => {
    expect(parseBasicAuthorization(basic("u", "p:w"))).toEqual({ user: "u", password: "p:w" });
    expect(parseBasicAuthorization("Bearer x")).toBeNull();
    expect(parseBasicAuthorization("Basic !!!")).toBeNull();
    expect(parseBasicAuthorization(`Basic ${btoa("nocolon")}`)).toBeNull();
    expect(parseBasicAuthorization(null)).toBeNull();
  });

  it("reads one cookie", () => {
    expect(readCookie("a=1; caelo_staging_access=tok; b=2", STAGING_SESSION_COOKIE)).toBe("tok");
    expect(readCookie("a=1", STAGING_SESSION_COOKIE)).toBeNull();
  });
});

describe("decideStagingAccess", () => {
  const decide = (settings: StagingAccessSettings, request: StagingAccessRequest) =>
    decideStagingAccess({ settings, secret: SECRET, request, nowSeconds: NOW });

  it("denies with 403 when nothing is enabled", async () => {
    expect(await decide(OFF, req())).toEqual({ allowed: false, status: 403 });
  });

  it("cookie mode: a valid session cookie gets in, an expired or open token does not", async () => {
    const s = { ...OFF, cookieEnabled: true };
    const session = await signStagingToken(SECRET, "session", NOW + 100);
    expect(await decide(s, req({ cookieHeader: `${STAGING_SESSION_COOKIE}=${session}` }))).toEqual({
      allowed: true,
      via: "cookie",
    });
    const expired = await signStagingToken(SECRET, "session", NOW - 1);
    expect(
      (await decide(s, req({ cookieHeader: `${STAGING_SESSION_COOKIE}=${expired}` }))).allowed,
    ).toBe(false);
    const open = await signStagingToken(SECRET, "open", NOW + 100);
    expect(
      (await decide(s, req({ cookieHeader: `${STAGING_SESSION_COOKIE}=${open}` }))).allowed,
    ).toBe(false);
    // Cookie mode off: the same valid cookie is ignored.
    expect(
      (await decide(OFF, req({ cookieHeader: `${STAGING_SESSION_COOKIE}=${session}` }))).allowed,
    ).toBe(false);
  });

  it("basic-auth mode: right user + derived password only; 401 otherwise", async () => {
    const s = { ...OFF, basicAuthEnabled: true };
    const pw = await deriveStagingCredential(SECRET, "basic-auth", "nonce-basic");
    expect(await decide(s, req({ authorizationHeader: basic("crawler", pw) }))).toEqual({
      allowed: true,
      via: "basic-auth",
    });
    expect(await decide(s, req({ authorizationHeader: basic("other", pw) }))).toEqual({
      allowed: false,
      status: 401,
    });
    expect(await decide(s, req({ authorizationHeader: basic("crawler", `${pw}x`) }))).toEqual({
      allowed: false,
      status: 401,
    });
    // A password derived for the header kind is not a basic-auth password.
    const headerValue = await deriveStagingCredential(SECRET, "basic-auth", "nonce-header");
    expect(
      (await decide(s, req({ authorizationHeader: basic("crawler", headerValue) }))).allowed,
    ).toBe(false);
    expect(await decide(s, req())).toEqual({ allowed: false, status: 401 });
  });

  it("basic-auth mode without a generated credential lets nobody in", async () => {
    const s = { ...OFF, basicAuthEnabled: true, basicAuthNonce: null };
    expect(await decide(s, req({ authorizationHeader: basic("crawler", "") }))).toEqual({
      allowed: false,
      status: 401,
    });
  });

  it("header mode: the derived value under the configured name only", async () => {
    const s = { ...OFF, headerEnabled: true };
    const value = await deriveStagingCredential(SECRET, "header", "nonce-header");
    expect(await decide(s, req({ headers: { "x-caelo-staging-key": value } }))).toEqual({
      allowed: true,
      via: "header",
    });
    expect((await decide(s, req({ headers: { "x-other": value } }))).allowed).toBe(false);
    expect((await decide(s, req({ headers: { "x-caelo-staging-key": "" } }))).allowed).toBe(false);
    expect(
      (await decide(s, req({ headers: { "x-caelo-staging-key": `${value}0` } }))).allowed,
    ).toBe(false);
  });

  it("IP mode: an allowlisted client address only", async () => {
    const s = { ...OFF, ipAllowlist: ["198.51.100.0/24", "2001:db8::/48"] };
    expect(await decide(s, req({ clientIp: "198.51.100.20" }))).toEqual({
      allowed: true,
      via: "ip",
    });
    expect(await decide(s, req({ clientIp: "2001:db8:0:1::5" }))).toEqual({
      allowed: true,
      via: "ip",
    });
    expect((await decide(s, req({ clientIp: "198.51.101.20" }))).allowed).toBe(false);
    expect((await decide(s, req({ clientIp: null }))).allowed).toBe(false);
  });
});

describe("safeStagingNextPath", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeStagingNextPath("/about/?x=1")).toBe("/about/?x=1");
    expect(safeStagingNextPath("//evil.example")).toBe("/");
    expect(safeStagingNextPath("https://evil.example")).toBe("/");
    expect(safeStagingNextPath("/\\evil")).toBe("/");
    expect(safeStagingNextPath("/a\r\nSet-Cookie: x")).toBe("/");
    expect(safeStagingNextPath(null)).toBe("/");
  });
});
