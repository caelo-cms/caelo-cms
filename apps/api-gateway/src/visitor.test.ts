// SPDX-License-Identifier: MPL-2.0

/**
 * #677 — visitor resolution under the consent provider's rule, without a
 * database: the rule and whether a plugin declares the visitor-id purpose
 * are passed in, so every consent state is one call.
 * The gateway-level behaviour against the real plugin is in
 * visitor-consent.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { VisitorConsentRule } from "@caelo-cms/plugin-host";
import { hashClientAddress } from "./client-ip.js";
import { signCookieValue, verifySignedCookie } from "./middleware/signed-cookie.js";
import { parseCookies, resolveVisitor, VISITOR_COOKIE_MAX_AGE } from "./visitor.js";

const SECRET = "test-secret-677";
const RULE: VisitorConsentRule = {
  cookie: "caelo_consent",
  policyVersion: 3,
  // What consent-manager derives from ratings' declaration.
  purposes: { visitor_id: "functional" },
};
const sign = (value: string) => signCookieValue({ value, secret: SECRET });

function consent(granted: string[], policyVersion = 3): string {
  return `caelo_consent=${encodeURIComponent(JSON.stringify({ granted, policyVersion }))}`;
}

function req(...cookies: string[]): Request {
  return new Request("http://localhost/api/plugin/x/y", {
    method: "POST",
    headers: cookies.length > 0 ? { cookie: cookies.join("; ") } : {},
  });
}

async function resolve(
  r: Request,
  rule: VisitorConsentRule | null = RULE,
  visitorIdDeclared = true,
) {
  return resolveVisitor({ req: r, secret: SECRET, rule, visitorIdDeclared, sign });
}

describe("resolveVisitor (#677)", () => {
  it("has no visitor id and sets nothing without a decision", async () => {
    const v = await resolve(req());
    expect(v.visitorId).toBeNull();
    expect(v.setCookies).toEqual([]);
  });

  it("has no visitor id after a decision without the declared category", async () => {
    const v = await resolve(req(consent(["necessary", "analytics", "marketing"])));
    expect(v.visitorId).toBeNull();
    expect(v.setCookies).toEqual([]);
  });

  it("mints a signed, HttpOnly id when the decision grants the declared category", async () => {
    const v = await resolve(req(consent(["necessary", "functional"])));
    expect(v.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.setCookies).toHaveLength(1);
    expect(v.setCookies[0]).toStartWith(`caelo_visitor_id=${v.visitorId}.`);
    expect(v.setCookies[0]).toContain("HttpOnly");
  });

  it("recognises an id it signed earlier and sets nothing new", async () => {
    const signed = await sign("22222222-2222-4222-8222-222222222222");
    const v = await resolve(req(consent(["functional"]), `caelo_visitor_id=${signed}`));
    expect(v.visitorId).toBe("22222222-2222-4222-8222-222222222222");
    expect(v.setCookies).toEqual([]);
  });

  it("replaces a tampered id with a fresh one (with consent)", async () => {
    const tampered = `22222222-2222-4222-8222-222222222222.${Math.floor(Date.now() / 1000)}.${"0".repeat(64)}`;
    const v = await resolve(req(consent(["functional"]), `caelo_visitor_id=${tampered}`));
    expect(v.visitorId).not.toBe("22222222-2222-4222-8222-222222222222");
    expect(v.setCookies[0]).toStartWith(`caelo_visitor_id=${v.visitorId}.`);
  });

  it("expires and ignores a held id once consent is withdrawn", async () => {
    const signed = await sign("33333333-3333-4333-8333-333333333333");
    const v = await resolve(req(consent(["necessary"]), `caelo_visitor_id=${signed}`));
    expect(v.visitorId).toBeNull();
    expect(v.setCookies).toHaveLength(1);
    expect(v.setCookies[0]).toStartWith("caelo_visitor_id=;");
    expect(v.setCookies[0]).toContain("Max-Age=0");
  });

  it("treats a decision under another policy version as no decision", async () => {
    const signed = await sign("44444444-4444-4444-8444-444444444444");
    const v = await resolve(req(consent(["functional"], 2), `caelo_visitor_id=${signed}`));
    expect(v.visitorId).toBeNull();
    expect(v.setCookies[0]).toStartWith("caelo_visitor_id=;");
  });

  it("treats a garbled decision cookie as no decision", async () => {
    for (const bad of ["caelo_consent=not-json", "caelo_consent=%5B%5D", "caelo_consent=null"]) {
      const v = await resolve(req(bad));
      expect(v.visitorId).toBeNull();
      expect(v.setCookies).toEqual([]);
    }
  });

  it("has no visitor id on a site without a consent provider, whatever the cookie says", async () => {
    const signed = await sign("55555555-5555-4555-8555-555555555555");
    const v = await resolve(req(consent(["functional"]), `caelo_visitor_id=${signed}`), null);
    expect(v.visitorId).toBeNull();
    expect(v.setCookies[0]).toStartWith("caelo_visitor_id=;");
  });

  it("never sets the id when no active plugin declares the visitor-id purpose", async () => {
    // Consent granted and the provider still classifies the key: without
    // a declaring plugin nothing needs the cookie, so it is not set.
    const fresh = await resolve(req(consent(["functional"])), RULE, false);
    expect(fresh.visitorId).toBeNull();
    expect(fresh.setCookies).toEqual([]);
    // One the browser still holds (from before the plugin was switched
    // off) is expired, not read.
    const signed = await sign("66666666-6666-4666-8666-666666666666");
    const held = await resolve(
      req(consent(["functional"]), `caelo_visitor_id=${signed}`),
      { ...RULE, purposes: {} },
      false,
    );
    expect(held.visitorId).toBeNull();
    expect(held.setCookies[0]).toStartWith("caelo_visitor_id=;");
    expect(held.setCookies[0]).toContain("Max-Age=0");
  });

  it("refuses a provider rule that does not classify a declared visitor id", async () => {
    const rule = { ...RULE, purposes: {} };
    await expect(resolve(req(consent(["functional"])), rule)).rejects.toThrow(
      'does not classify the "visitor_id" purpose',
    );
  });

  it("reads the decision cookie the provider names", async () => {
    const rule = { ...RULE, cookie: "site_choice" };
    const named = `site_choice=${encodeURIComponent(JSON.stringify({ granted: ["functional"], policyVersion: 3 }))}`;
    expect((await resolve(req(named), rule)).visitorId).not.toBeNull();
    expect((await resolve(req(consent(["functional"])), rule)).visitorId).toBeNull();
  });
});

describe("parseCookies", () => {
  it("skips a cookie whose value is not valid percent-encoding", () => {
    expect(parseCookies("a=%E0%A4%A; b=2")).toEqual({ b: "2" });
  });

  it("decodes values and ignores pairs without a name", () => {
    expect(parseCookies("=x; c=%7B%7D;  d=1")).toEqual({ c: "{}", d: "1" });
  });
});

describe("signed-cookie hex & session maxAge hardening", () => {
  it("rejects signatures with trailing non-hex characters inside a byte pair", async () => {
    const signed = await sign("abc");
    const [val, ts] = signed.split(".");
    const badSig = `${"0z".repeat(32)}`;
    expect(
      await verifySignedCookie({ signed: `${val}.${ts}.${badSig}`, secret: SECRET }),
    ).toBeNull();
  });

  it("rejects an expired caelo_session cookie older than VISITOR_COOKIE_MAX_AGE", async () => {
    const token = "a".repeat(64);
    const oldSession = await signCookieValue({
      value: token,
      secret: SECRET,
      issuedAt: Math.floor(Date.now() / 1000) - VISITOR_COOKIE_MAX_AGE - 10,
    });
    const freshSession = await signCookieValue({
      value: token,
      secret: SECRET,
    });
    expect((await resolve(req(`caelo_session=${oldSession}`))).sessionToken).toBeNull();
    expect((await resolve(req(`caelo_session=${freshSession}`))).sessionToken).toBe(token);
  });

  it("hashes client addresses with 256-bit SHA-256 (64 hex chars)", () => {
    const h = hashClientAddress("192.0.2.1");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(hashClientAddress("192.0.2.2"));
  });
});
