// SPDX-License-Identifier: MPL-2.0

/**
 * #677 — visitor resolution under the consent provider's rule, without a
 * database: the rule and whether a plugin declares the visitor-id purpose
 * are passed in, so every consent state is one call.
 * #1343 — the id and the login session are entries of the one `__session`
 * cookie, and the decision arrives in the `x-caelo-consent` header: the
 * only two things that cross a Firebase Hosting rewrite.
 * The gateway-level behaviour against the real plugin is in
 * visitor-consent.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { VisitorConsentRule } from "@caelo-cms/plugin-host";
import { readSessionCookie, SESSION_ENTRY, sessionCookieValue } from "@caelo-cms/shared";
import { hashClientAddress } from "./client-ip.js";
import { signCookieValue, verifySignedCookie } from "./middleware/signed-cookie.js";
import { parseCookies, resolveVisitor, VISITOR_COOKIE_MAX_AGE } from "./visitor.js";

const SECRET = "test-secret-677";
const RULE: VisitorConsentRule = {
  policyVersion: 3,
  // What consent-manager derives from ratings' declaration.
  purposes: { visitor_id: "functional" },
};
const sign = (value: string) => signCookieValue({ value, secret: SECRET });
const NOW = () => Math.floor(Date.now() / 1000);

/** The consent header value the runtime sends for a decision. */
function consent(granted: string[], policyVersion = 3): string {
  return `v=${policyVersion}; granted=${granted.join(",")}`;
}

/** A `__session` cookie holding these gateway entries. */
function session(entries: { vid?: string; login?: string }): string {
  const m = new Map<string, { value: string; expiresAt: number }>();
  if (entries.vid) m.set(SESSION_ENTRY.visitorId, { value: entries.vid, expiresAt: NOW() + 600 });
  if (entries.login) m.set(SESSION_ENTRY.login, { value: entries.login, expiresAt: NOW() + 600 });
  return `__session=${sessionCookieValue(m)}`;
}

function req(opts: { consent?: string; cookies?: string[] } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.consent) headers["x-caelo-consent"] = opts.consent;
  if (opts.cookies?.length) headers.cookie = opts.cookies.join("; ");
  return new Request("http://localhost/api/plugin/x/y", { method: "POST", headers });
}

async function resolve(
  r: Request,
  rule: VisitorConsentRule | null = RULE,
  visitorIdDeclared = true,
) {
  return resolveVisitor({ req: r, secret: SECRET, rule, visitorIdDeclared, sign });
}

/** The entries the response's `__session` Set-Cookie stores, or null when it sets none. */
function stored(v: Awaited<ReturnType<typeof resolve>>): Map<string, string> | null {
  const header = v.cookies.setCookieHeaders().find((c) => c.startsWith("__session="));
  if (!header) return null;
  return new Map(
    [...readSessionCookie(header.split(";")[0] ?? null, NOW())].map(([k, e]) => [k, e.value]),
  );
}

describe("resolveVisitor (#677, #1343)", () => {
  it("has no visitor id and sets nothing without a decision", async () => {
    const v = await resolve(req());
    expect(v.visitorId).toBeNull();
    expect(v.cookies.setCookieHeaders()).toEqual([]);
  });

  it("has no visitor id after a decision without the declared category", async () => {
    const v = await resolve(req({ consent: consent(["necessary", "analytics", "marketing"]) }));
    expect(v.visitorId).toBeNull();
    expect(v.cookies.setCookieHeaders()).toEqual([]);
  });

  it("mints a signed id in an HttpOnly __session when the decision grants the declared category", async () => {
    const v = await resolve(req({ consent: consent(["necessary", "functional"]) }));
    expect(v.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    const headers = v.cookies.setCookieHeaders();
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("HttpOnly");
    expect(headers[0]).toContain("SameSite=Lax");
    expect(headers[0]).toContain(`Max-Age=${VISITOR_COOKIE_MAX_AGE}`);
    expect(stored(v)?.get("vid")).toStartWith(`${v.visitorId}.`);
  });

  it("recognises an id it signed earlier and sets nothing new", async () => {
    const signed = await sign("22222222-2222-4222-8222-222222222222");
    const v = await resolve(
      req({ consent: consent(["functional"]), cookies: [session({ vid: signed })] }),
    );
    expect(v.visitorId).toBe("22222222-2222-4222-8222-222222222222");
    expect(v.cookies.setCookieHeaders()).toEqual([]);
  });

  it("replaces a tampered id with a fresh one (with consent)", async () => {
    const tampered = `22222222-2222-4222-8222-222222222222.${NOW()}.${"0".repeat(64)}`;
    const v = await resolve(
      req({ consent: consent(["functional"]), cookies: [session({ vid: tampered })] }),
    );
    expect(v.visitorId).not.toBe("22222222-2222-4222-8222-222222222222");
    expect(stored(v)?.get("vid")).toStartWith(`${v.visitorId}.`);
  });

  it("removes and ignores a held id once consent is withdrawn", async () => {
    const signed = await sign("33333333-3333-4333-8333-333333333333");
    const v = await resolve(
      req({ consent: consent(["necessary"]), cookies: [session({ vid: signed })] }),
    );
    expect(v.visitorId).toBeNull();
    const headers = v.cookies.setCookieHeaders();
    expect(headers).toHaveLength(1);
    expect(headers[0]).toStartWith("__session=;");
    expect(headers[0]).toContain("Max-Age=0");
  });

  it("keeps the login session when it removes the id", async () => {
    const vid = await sign("33333333-3333-4333-8333-333333333333");
    const login = await sign("b".repeat(64));
    const v = await resolve(
      req({ consent: consent(["necessary"]), cookies: [session({ vid, login })] }),
    );
    expect(v.sessionToken).toBe("b".repeat(64));
    expect(stored(v)).toEqual(new Map([["login", login]]));
  });

  it("treats a decision under another policy version as no decision", async () => {
    const signed = await sign("44444444-4444-4444-8444-444444444444");
    const v = await resolve(
      req({ consent: consent(["functional"], 2), cookies: [session({ vid: signed })] }),
    );
    expect(v.visitorId).toBeNull();
    expect(v.cookies.setCookieHeaders()[0]).toStartWith("__session=;");
  });

  it("treats a garbled decision header as no decision", async () => {
    for (const bad of ["not-a-decision", "v=3", '{"granted":["functional"],"policyVersion":3}']) {
      const v = await resolve(req({ consent: bad }));
      expect(v.visitorId).toBeNull();
      expect(v.cookies.setCookieHeaders()).toEqual([]);
    }
  });

  it("reads no consent cookie: only the header counts (#1343)", async () => {
    const cookie = `caelo_consent=${encodeURIComponent(JSON.stringify({ granted: ["functional"], policyVersion: 3 }))}`;
    expect((await resolve(req({ cookies: [cookie] }))).visitorId).toBeNull();
  });

  it("has no visitor id on a site without a consent provider, whatever the header says", async () => {
    const signed = await sign("55555555-5555-4555-8555-555555555555");
    const v = await resolve(
      req({ consent: consent(["functional"]), cookies: [session({ vid: signed })] }),
      null,
    );
    expect(v.visitorId).toBeNull();
    expect(v.cookies.setCookieHeaders()[0]).toStartWith("__session=;");
  });

  it("never sets the id when no active plugin declares the visitor-id purpose", async () => {
    // Consent granted and the provider still classifies the key: without
    // a declaring plugin nothing needs the id, so it is not set.
    const fresh = await resolve(req({ consent: consent(["functional"]) }), RULE, false);
    expect(fresh.visitorId).toBeNull();
    expect(fresh.cookies.setCookieHeaders()).toEqual([]);
    // One the browser still holds (from before the plugin was switched
    // off) is removed, not read.
    const signed = await sign("66666666-6666-4666-8666-666666666666");
    const held = await resolve(
      req({ consent: consent(["functional"]), cookies: [session({ vid: signed })] }),
      { ...RULE, purposes: {} },
      false,
    );
    expect(held.visitorId).toBeNull();
    expect(held.cookies.setCookieHeaders()[0]).toStartWith("__session=;");
  });

  it("refuses a provider rule that does not classify a declared visitor id", async () => {
    const rule = { ...RULE, purposes: {} };
    await expect(resolve(req({ consent: consent(["functional"]) }), rule)).rejects.toThrow(
      'does not classify the "visitor_id" purpose',
    );
  });

  it("keeps another owner's entry when it rewrites the container", async () => {
    const m = new Map([[SESSION_ENTRY.staging, { value: "session.1.abc", expiresAt: NOW() + 60 }]]);
    const v = await resolve(
      req({ consent: consent(["functional"]), cookies: [`__session=${sessionCookieValue(m)}`] }),
    );
    expect(stored(v)?.get("staging")).toBe("session.1.abc");
    expect(stored(v)?.get("vid")).toStartWith(`${v.visitorId}.`);
  });
});

describe("cookies from before #1343", () => {
  it("expires caelo_visitor_id and never reads it", async () => {
    const signed = await sign("77777777-7777-4777-8777-777777777777");
    const v = await resolve(
      req({ consent: consent(["functional"]), cookies: [`caelo_visitor_id=${signed}`] }),
    );
    expect(v.visitorId).not.toBe("77777777-7777-4777-8777-777777777777");
    expect(v.cookies.setCookieHeaders()).toContain(
      "caelo_visitor_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });

  it("expires the gateway's own caelo_session, never the admin's", async () => {
    const ours = await sign("c".repeat(64));
    const v = await resolve(req({ cookies: [`caelo_session=${ours}`] }));
    expect(v.sessionToken).toBeNull();
    expect(v.cookies.setCookieHeaders()).toEqual([
      "caelo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    // An admin session on a shared host (local development) is not ours.
    const admin = await resolve(req({ cookies: ["caelo_session=admin-session-token"] }));
    expect(admin.cookies.setCookieHeaders()).toEqual([]);
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

  it("rejects a login entry signed longer ago than VISITOR_COOKIE_MAX_AGE, and drops it", async () => {
    const token = "a".repeat(64);
    const oldSession = await signCookieValue({
      value: token,
      secret: SECRET,
      issuedAt: NOW() - VISITOR_COOKIE_MAX_AGE - 10,
    });
    const freshSession = await signCookieValue({ value: token, secret: SECRET });
    const old = await resolve(req({ cookies: [session({ login: oldSession })] }));
    expect(old.sessionToken).toBeNull();
    expect(old.cookies.setCookieHeaders()[0]).toStartWith("__session=;");
    expect((await resolve(req({ cookies: [session({ login: freshSession })] }))).sessionToken).toBe(
      token,
    );
  });

  it("hashes client addresses with 256-bit SHA-256 (64 hex chars)", () => {
    const h = hashClientAddress("192.0.2.1");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(hashClientAddress("192.0.2.2"));
  });
});
