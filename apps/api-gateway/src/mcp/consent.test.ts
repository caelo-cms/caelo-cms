// SPDX-License-Identifier: MPL-2.0

/**
 * #806 follow-up — the broker's consent page and its browser binding: a
 * link to /authorize never reaches Google without the user approving on
 * this origin, an approval cannot be forged from elsewhere, and a sign-in
 * cannot be finished in a browser that did not approve it.
 */

import { describe, expect, it } from "bun:test";
import {
  approve,
  authorizeQuery,
  CLAUDE_REDIRECT,
  decide,
  harness,
  ISSUER,
  location,
  PUBLIC,
  pkce,
  readConsent,
  registerClient,
} from "./__tests__/harness.js";
import { escapeHtml } from "./consent.js";

const CHATGPT_CALLBACK = "https://chatgpt.com/connector/oauth/attacker-chosen-id";

function query(clientId: string, over: Record<string, string | undefined> = {}) {
  return authorizeQuery({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    state: "s1",
    ...over,
  });
}

describe("consent page", () => {
  it("answers GET /authorize with a 200 page, never a redirect to Google", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CHATGPT_CALLBACK], "Totally Claude");
    const res = await h.send(
      query(clientId, { redirect_uri: CHATGPT_CALLBACK, resource: `${PUBLIC}/api/mcp/admin` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.clone().text();
    // Where the code goes, the self-chosen name marked unverified, and the surface.
    expect(html).toContain("https://chatgpt.com");
    expect(html).toContain("Totally Claude");
    expect(html).toContain("name not verified");
    expect(html).toContain("admin tools");
    expect(html).not.toContain("accounts.google.com/o/oauth2");
    // Nothing left the gateway: no Google, no CIMD for a DCR client.
    expect(h.calls).toHaveLength(0);
  });

  it("sends a strict CSP, no framing, no caching, and a __Host- SameSite=Lax binding cookie", async () => {
    const h = harness();
    const res = await h.send(query(await registerClient(h, [CLAUDE_REDIRECT])));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("form-action 'self' https://accounts.google.com https://claude.ai");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-caelo-mcp-consent-[0-9a-f]{16}=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=1200"]) {
      expect(cookie).toContain(attr);
    }
    expect(cookie).not.toContain("Domain=");
    expect(await res.text()).not.toContain("<script");
  });

  it("escapes the client's self-chosen name", async () => {
    const h = harness();
    const evil = `<img src=x onerror=alert(1)>"'&`;
    const res = await h.send(query(await registerClient(h, [CLAUDE_REDIRECT], evil)));
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(evil));
  });

  it("says when an app sends the user back to this computer", async () => {
    const h = harness();
    const res = await h.send(
      query(await registerClient(h, ["http://127.0.0.1/callback"]), {
        redirect_uri: "http://127.0.0.1:4567/callback",
      }),
    );
    const html = await res.text();
    expect(html).toContain("http://127.0.0.1:4567");
    expect(html).toContain("an app running on this computer");
  });
});

describe("consent decision (POST /authorize)", () => {
  it("approve with the matching cookie redirects to Google", async () => {
    const h = harness();
    const { google } = await approve(h, {
      response_type: "code",
      client_id: await registerClient(h, [CLAUDE_REDIRECT]),
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect(google.origin).toBe("https://accounts.google.com");
  });

  it("refuses an approval without the cookie, with a wrong cookie, or with another sign-in's cookie", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const mine = await readConsent(await h.send(query(clientId)));
    const other = await readConsent(await h.send(query(clientId)));
    const [name] = mine.cookie.split("=") as [string];
    for (const cookie of [
      null,
      `${name}=${"A".repeat(43)}`,
      other.cookie,
      `${other.cookie.split("=")[0]}=${mine.cookie.split("=")[1]}`,
    ]) {
      const res = await decide(h, { token: mine.token, cookie });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    // A deny is bound the same way: a foreign page cannot cancel the user's sign-in either.
    const deny = await decide(h, { token: mine.token, cookie: null }, "deny");
    expect(deny.status).toBe(400);
  });

  it("refuses an approval posted from another origin", async () => {
    const h = harness();
    const consent = await readConsent(
      await h.send(query(await registerClient(h, [CLAUDE_REDIRECT]))),
    );
    const res = await decide(h, consent, "approve", { origin: "https://evil.example" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses an expired, forged or wrong-purpose consent token", async () => {
    const h = harness();
    const clientId = await registerClient(h, [CLAUDE_REDIRECT]);
    const consent = await readConsent(await h.send(query(clientId)));
    for (const token of [clientId, `${consent.token.slice(0, -2)}AA`, "v2.x.y.z"]) {
      expect((await decide(h, { token, cookie: consent.cookie })).status).toBe(400);
    }
    h.advance(10 * 60 * 1000);
    expect((await decide(h, consent)).status).toBe(400);
  });

  it("deny sends access_denied back to the client with iss and state, and clears the cookie", async () => {
    const h = harness();
    const consent = await readConsent(
      await h.send(query(await registerClient(h, [CLAUDE_REDIRECT]))),
    );
    const res = await decide(h, consent, "deny");
    expect(res.status).toBe(302);
    const loc = location(res);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("refuses a malformed form", async () => {
    const h = harness();
    const consent = await readConsent(
      await h.send(query(await registerClient(h, [CLAUDE_REDIRECT]))),
    );
    for (const body of [
      `consent=${encodeURIComponent(consent.token)}`,
      `consent=${encodeURIComponent(consent.token)}&decision=maybe`,
      `consent=${encodeURIComponent(consent.token)}&decision=approve&decision=deny`,
    ]) {
      const res = await h.send("/api/mcp/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: consent.cookie },
        body,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("google-callback consent binding", () => {
  async function approved() {
    const h = harness();
    const { googleState, cookie } = await approve(h, {
      response_type: "code",
      client_id: await registerClient(h, [CLAUDE_REDIRECT]),
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      state: "s1",
    });
    return { h, googleState, cookie };
  }

  it("refuses a callback without the consent cookie", async () => {
    const { h, googleState, cookie } = await approved();
    const path = `/api/mcp/oauth/google-callback?code=4%2Fx&state=${encodeURIComponent(googleState)}`;
    const variants: Record<string, string>[] = [
      {},
      { cookie: `${cookie.split("=")[0]}=${"B".repeat(43)}` },
    ];
    for (const headers of variants) {
      const res = await h.send(path, { headers });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("refuses a callback carrying another sign-in's cookie", async () => {
    const { h, googleState } = await approved();
    const { cookie: other } = await approved();
    const res = await h.send(
      `/api/mcp/oauth/google-callback?code=4%2Fx&state=${encodeURIComponent(googleState)}`,
      { headers: { cookie: other } },
    );
    expect(res.status).toBe(400);
  });

  it("completes with the cookie and deletes it", async () => {
    const { h, googleState, cookie } = await approved();
    const res = await h.send(
      `/api/mcp/oauth/google-callback?code=4%2Fx&state=${encodeURIComponent(googleState)}`,
      { headers: { cookie: `unrelated=1; ${cookie}` } },
    );
    expect(res.status).toBe(302);
    expect(location(res).searchParams.get("code")).toStartWith("v2.");
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toStartWith(`${cookie.split("=")[0]}=;`);
    expect(cleared).toContain("Max-Age=0");
  });
});
