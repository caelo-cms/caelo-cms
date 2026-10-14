// SPDX-License-Identifier: MPL-2.0

/**
 * #677 — visitor resolution under the consent provider's rule, without a
 * database: the rule is passed in, so every consent state is one call.
 * The gateway-level behaviour against the real plugin is in
 * visitor-consent.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { VisitorConsentRule } from "@caelo-cms/plugin-host";
import { signCookieValue } from "./middleware/signed-cookie.js";
import { parseCookies, resolveVisitor } from "./visitor.js";

const SECRET = "test-secret-677";
const RULE: VisitorConsentRule = {
  cookie: "caelo_consent",
  policyVersion: 3,
  purposes: { visitor_id: "analytics" },
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

async function resolve(r: Request, rule: VisitorConsentRule | null = RULE) {
  return resolveVisitor({ req: r, secret: SECRET, rule, sign });
}

describe("resolveVisitor (#677)", () => {
  it("has no visitor id and sets nothing without a decision", async () => {
    const v = await resolve(req());
    expect(v).toMatchObject({ visitorId: null, visitorIdHash: "", recognised: false });
    expect(v.setCookies).toEqual([]);
  });

  it("has no visitor id after a decision without analytics", async () => {
    const v = await resolve(req(consent(["necessary", "functional", "marketing"])));
    expect(v.visitorId).toBeNull();
    expect(v.setCookies).toEqual([]);
  });

  it("mints a signed, HttpOnly id when the decision grants analytics", async () => {
    const v = await resolve(req(consent(["necessary", "analytics"])));
    expect(v.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.recognised).toBe(false);
    expect(v.setCookies).toHaveLength(1);
    expect(v.setCookies[0]).toStartWith(`caelo_visitor_id=${v.visitorId}.`);
    expect(v.setCookies[0]).toContain("HttpOnly");
  });

  it("recognises an id it signed earlier and sets nothing new", async () => {
    const signed = await sign("22222222-2222-4222-8222-222222222222");
    const v = await resolve(req(consent(["analytics"]), `caelo_visitor_id=${signed}`));
    expect(v).toMatchObject({
      visitorId: "22222222-2222-4222-8222-222222222222",
      recognised: true,
    });
    expect(v.setCookies).toEqual([]);
  });

  it("replaces a tampered id with a fresh one (with consent)", async () => {
    const tampered = `22222222-2222-4222-8222-222222222222.${Math.floor(Date.now() / 1000)}.${"0".repeat(64)}`;
    const v = await resolve(req(consent(["analytics"]), `caelo_visitor_id=${tampered}`));
    expect(v.visitorId).not.toBe("22222222-2222-4222-8222-222222222222");
    expect(v.recognised).toBe(false);
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
    const v = await resolve(req(consent(["analytics"], 2), `caelo_visitor_id=${signed}`));
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
    const v = await resolve(req(consent(["analytics"]), `caelo_visitor_id=${signed}`), null);
    expect(v.visitorId).toBeNull();
    expect(v.setCookies[0]).toStartWith("caelo_visitor_id=;");
  });

  it("refuses a provider rule that does not classify the visitor id", async () => {
    const rule = { ...RULE, purposes: {} };
    await expect(resolve(req(consent(["analytics"])), rule)).rejects.toThrow(
      'does not classify the "visitor_id" purpose',
    );
  });

  it("reads the decision cookie the provider names", async () => {
    const rule = { ...RULE, cookie: "site_choice" };
    const named = `site_choice=${encodeURIComponent(JSON.stringify({ granted: ["analytics"], policyVersion: 3 }))}`;
    expect((await resolve(req(named), rule)).visitorId).not.toBeNull();
    expect((await resolve(req(consent(["analytics"])), rule)).visitorId).toBeNull();
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
