// SPDX-License-Identifier: MPL-2.0

/**
 * #650 — the staging.<domain> gate + proxy, against a fake preview origin.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_STAGING_HEADER_NAME,
  deriveStagingCredential,
  STAGING_SESSION_COOKIE,
  type StagingAccessSettings,
  signStagingToken,
  verifyStagingToken,
} from "@caelo-cms/shared";
import {
  cloudRunClientIp,
  handleStagingRequest,
  isStagingRequest,
  rewriteLocation,
  type StagingState,
  stagingGateFromEnv,
} from "./staging-proxy.js";

const SECRET = "gate-secret-for-tests";
const STAGING = "https://staging.example.com";
const PREVIEW = "https://site--runid-abc.web.app";
const NOW = 1_800_000_000;

const SETTINGS: StagingAccessSettings = {
  cookieEnabled: true,
  basicAuthEnabled: false,
  basicAuthUser: "crawler",
  basicAuthNonce: "nb",
  headerEnabled: false,
  headerName: DEFAULT_STAGING_HEADER_NAME,
  headerNonce: "nh",
  ipAllowlist: [],
};

interface Captured {
  url: string;
  init: RequestInit & { decompress?: boolean };
}

function harness(over: Partial<StagingState> = {}, upstream?: (c: Captured) => Response) {
  const calls: Captured[] = [];
  const state: StagingState = {
    host: "staging.example.com",
    settings: SETTINGS,
    originUrl: PREVIEW,
    ...over,
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return upstream
      ? upstream(c)
      : new Response("<h1>staged</h1>", {
          status: 200,
          headers: { "content-type": "text/html", "x-robots-tag": "noindex" },
        });
  }) as unknown as typeof fetch;
  const serve = (path: string, init: RequestInit = {}) =>
    handleStagingRequest(new Request(`${STAGING}${path}`, init), {
      config: { stagingOrigin: STAGING, secret: SECRET },
      loadState: async () => state,
      fetchImpl,
      nowSeconds: () => NOW,
    });
  return { calls, serve };
}

async function sessionCookieHeader(): Promise<string> {
  return `${STAGING_SESSION_COOKIE}=${await signStagingToken(SECRET, "session", NOW + 3600)}`;
}

describe("staging host detection + config", () => {
  it("serves a staging host on gcp-firebase only, and matches the configured host", () => {
    expect(stagingGateFromEnv({ CAELO_PROVIDER: "gcp" })).toBeNull();
    expect(stagingGateFromEnv({})).toBeNull();
    expect(
      stagingGateFromEnv({ CAELO_PROVIDER: "gcp-firebase", CAELO_STAGING_GATE_SECRET: "s" }),
    ).toEqual({ secret: "s" });
    expect(stagingGateFromEnv({ CAELO_PROVIDER: "gcp-firebase" })?.secret).toBeNull();
    const req = (host: string) => new Request("http://gateway.internal/x", { headers: { host } });
    expect(isStagingRequest(req("staging.example.com"), "staging.example.com")).toBe(true);
    expect(isStagingRequest(req("STAGING.example.com"), "staging.example.com")).toBe(true);
    // A host the operator chose instead of staging.<domain>.
    expect(isStagingRequest(req("preview.other.de"), "preview.other.de")).toBe(true);
    expect(isStagingRequest(req("www.example.com"), "staging.example.com")).toBe(false);
  });

  it("trusts only the last X-Forwarded-For entry (the one Cloud Run appended)", () => {
    expect(cloudRunClientIp("1.2.3.4")).toBe("1.2.3.4");
    expect(cloudRunClientIp("6.6.6.6, 198.51.100.7")).toBe("198.51.100.7");
    expect(cloudRunClientIp(null)).toBeNull();
    expect(cloudRunClientIp("")).toBeNull();
  });
});

describe("rewriteLocation", () => {
  it("re-addresses absolute redirects on the preview origin only", () => {
    expect(rewriteLocation(`${PREVIEW}/about/?a=1#x`, PREVIEW, STAGING)).toBe(
      `${STAGING}/about/?a=1#x`,
    );
    expect(rewriteLocation("/about/", PREVIEW, STAGING)).toBe("/about/");
    expect(rewriteLocation("https://other.example/a", PREVIEW, STAGING)).toBe(
      "https://other.example/a",
    );
    expect(rewriteLocation(`//site--runid-abc.web.app/x`, PREVIEW, STAGING)).toBe(`${STAGING}/x`);
  });
});

describe("handleStagingRequest — gate", () => {
  it("unauthenticated: 403 with a page pointing to the admin, never reaching the origin", async () => {
    const h = harness();
    const r = await h.serve("/");
    expect(r.status).toBe(403);
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.headers.get("www-authenticate")).toBeNull();
    expect(await r.text()).toContain("Open staging");
    expect(h.calls).toEqual([]);
  });

  it("unauthenticated with basic auth on: 401 + WWW-Authenticate: Basic", async () => {
    const h = harness({ settings: { ...SETTINGS, basicAuthEnabled: true } });
    const r = await h.serve("/");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Basic");
    expect(h.calls).toEqual([]);
  });

  it("a valid session cookie gets through; the cookie is not forwarded", async () => {
    const h = harness();
    const r = await h.serve("/about/", {
      headers: { cookie: `a=1; ${await sessionCookieHeader()}; b=2` },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<h1>staged</h1>");
    expect(h.calls[0]?.url).toBe(`${PREVIEW}/about/`);
    const fwd = new Headers(h.calls[0]?.init.headers);
    expect(fwd.get("cookie")).toBe("a=1; b=2");
    expect(fwd.get("x-forwarded-host")).toBe("staging.example.com");
  });

  it("basic auth gets through and its Authorization header is stripped", async () => {
    const h = harness({ settings: { ...SETTINGS, cookieEnabled: false, basicAuthEnabled: true } });
    const pw = await deriveStagingCredential(SECRET, "basic-auth", "nb");
    const r = await h.serve("/", {
      headers: { authorization: `Basic ${btoa(`crawler:${pw}`)}` },
    });
    expect(r.status).toBe(200);
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBeNull();
    const wrong = await h.serve("/", {
      headers: { authorization: `Basic ${btoa("crawler:guess")}` },
    });
    expect(wrong.status).toBe(401);
  });

  it("the secret header gets through and is not forwarded", async () => {
    const h = harness({ settings: { ...SETTINGS, headerEnabled: true } });
    const value = await deriveStagingCredential(SECRET, "header", "nh");
    const r = await h.serve("/", { headers: { "x-caelo-staging-key": value } });
    expect(r.status).toBe(200);
    expect(new Headers(h.calls[0]?.init.headers).get("x-caelo-staging-key")).toBeNull();
  });

  it("forwards a site's own Authorization / same-named header when they did not authenticate the gate", async () => {
    // Codex review on #652: the staged app may use Basic auth itself, or a
    // header that happens to share the gate's name. Admitted by the session
    // cookie, those must reach the origin exactly as production gets them.
    const h = harness({ settings: { ...SETTINGS, basicAuthEnabled: true, headerEnabled: false } });
    const siteLogin = `Basic ${btoa("crawler:the-sites-own-password")}`;
    const r = await h.serve("/members/", {
      headers: {
        cookie: await sessionCookieHeader(),
        authorization: siteLogin,
        "x-caelo-staging-key": "an-app-value",
      },
    });
    expect(r.status).toBe(200);
    const fwd = new Headers(h.calls[0]?.init.headers);
    expect(fwd.get("authorization")).toBe(siteLogin);
    expect(fwd.get("x-caelo-staging-key")).toBe("an-app-value");
    // The gate's own session cookie still never leaves the gate.
    expect(fwd.get("cookie")).toBeNull();
  });

  it("strips the secret header only when it carried the gate's credential", async () => {
    const h = harness({ settings: { ...SETTINGS, headerEnabled: true } });
    await h.serve("/", {
      headers: { cookie: await sessionCookieHeader(), "x-caelo-staging-key": "not-the-gate-value" },
    });
    expect(new Headers(h.calls[0]?.init.headers).get("x-caelo-staging-key")).toBe(
      "not-the-gate-value",
    );
  });

  it("IP allowlist uses the Cloud Run client address, not a spoofed first hop", async () => {
    const h = harness({ settings: { ...SETTINGS, ipAllowlist: ["198.51.100.0/24"] } });
    const ok = await h.serve("/", { headers: { "x-forwarded-for": "198.51.100.9" } });
    expect(ok.status).toBe(200);
    const spoofed = await h.serve("/", {
      headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.50" },
    });
    expect(spoofed.status).toBe(403);
  });

  it("refuses to serve without the gate key", async () => {
    const r = await handleStagingRequest(new Request(`${STAGING}/`), {
      config: { stagingOrigin: STAGING, secret: null },
      loadState: async () => ({
        host: "staging.example.com",
        settings: SETTINGS,
        originUrl: PREVIEW,
      }),
    });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("cms-provision upgrade");
  });

  it("says nothing is staged after Publish live", async () => {
    const h = harness({ originUrl: null });
    const r = await h.serve("/", { headers: { cookie: await sessionCookieHeader() } });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Nothing is staged");
    expect(h.calls).toEqual([]);
  });
});

describe("handleStagingRequest — Open staging", () => {
  it("turns a valid open token into a session cookie and a same-origin redirect", async () => {
    const h = harness();
    const token = await signStagingToken(SECRET, "open", NOW + 60);
    const r = await h.serve(
      `/_caelo/staging-access?t=${encodeURIComponent(token)}&next=${encodeURIComponent("/de/preise/")}`,
    );
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/de/preise/");
    // A page path in any script still redirects (percent-encoded).
    const ja = await h.serve(
      `/_caelo/staging-access?t=${encodeURIComponent(token)}&next=${encodeURIComponent("/ja/料金/")}`,
    );
    expect(ja.status).toBe(303);
    expect(ja.headers.get("location")).toBe("/ja/%E6%96%99%E9%87%91/");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${STAGING_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const value = cookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    expect(await verifyStagingToken(SECRET, value, "session", NOW)).toBe(true);
  });

  it("refuses expired, forged or session tokens and off-site next targets", async () => {
    const h = harness();
    const expired = await signStagingToken(SECRET, "open", NOW - 1);
    expect((await h.serve(`/_caelo/staging-access?t=${expired}`)).status).toBe(403);
    const session = await signStagingToken(SECRET, "session", NOW + 60);
    expect((await h.serve(`/_caelo/staging-access?t=${session}`)).status).toBe(403);
    expect((await h.serve("/_caelo/staging-access?t=open.1.x")).status).toBe(403);
    const token = await signStagingToken(SECRET, "open", NOW + 60);
    const r = await h.serve(`/_caelo/staging-access?t=${token}&next=//evil.example`);
    expect(r.headers.get("location")).toBe("/");
    // A tab or newline is deleted by the browser's URL parser, turning
    // `/<TAB>/evil.example` into `//evil.example`: refused as off-site.
    for (const sneaky of ["/\t/evil.example", "/\n/evil.example", "/\u0000x"]) {
      const s = await h.serve(
        `/_caelo/staging-access?t=${token}&next=${encodeURIComponent(sneaky)}`,
      );
      expect(s.headers.get("location")).toBe("/");
    }
  });

  it("refuses when the admin cookie mode is off", async () => {
    const h = harness({
      settings: { ...SETTINGS, cookieEnabled: false, basicAuthEnabled: true },
    });
    const token = await signStagingToken(SECRET, "open", NOW + 60);
    expect((await h.serve(`/_caelo/staging-access?t=${token}`)).status).toBe(403);
  });
});

describe("handleStagingRequest — transparent proxy", () => {
  it("passes status, headers and body through unchanged and rewrites redirects", async () => {
    const h = harness({}, (c) =>
      c.url.endsWith("/old")
        ? new Response(null, {
            status: 301,
            headers: { location: `${PREVIEW}/new/`, "cache-control": "max-age=60" },
          })
        : new Response("gz-bytes", {
            status: 404,
            headers: {
              "content-type": "text/html",
              "content-encoding": "gzip",
              "cache-control": "public, max-age=60",
              "set-cookie": "a=1",
            },
          }),
    );
    const cookie = await sessionCookieHeader();
    const redirect = await h.serve("/old", { headers: { cookie } });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe(`${STAGING}/new/`);
    // Never shareable: a cache between browser and gate must not replay an
    // admitted response to someone the gate refuses (codex review on #652).
    expect(redirect.headers.get("cache-control")).toBe("private, no-store");
    expect(redirect.headers.get("x-robots-tag")).toBe("noindex");
    expect(h.calls[0]?.init.redirect).toBe("manual");
    expect(h.calls[0]?.init.decompress).toBe(false);

    const missing = await h.serve("/nope?x=1", { headers: { cookie } });
    expect(h.calls[1]?.url).toBe(`${PREVIEW}/nope?x=1`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-encoding")).toBe("gzip");
    expect(missing.headers.get("set-cookie")).toBe("a=1");
    // Hosting's `public, max-age=60` is not passed on.
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(await missing.text()).toBe("gz-bytes");
  });

  it("forwards request bodies of non-GET requests", async () => {
    const h = harness({}, () => new Response("ok"));
    await h.serve("/api/plugin/forms/submit", {
      method: "POST",
      body: '{"a":1}',
      headers: { cookie: await sessionCookieHeader(), "content-type": "application/json" },
    });
    expect(h.calls[0]?.init.method).toBe("POST");
    expect(await new Response(h.calls[0]?.init.body as BodyInit).text()).toBe('{"a":1}');
  });

  it("answers 502 when the preview origin is unreachable", async () => {
    const h = harness({}, () => {
      throw new Error("ECONNRESET");
    });
    const r = await h.serve("/", { headers: { cookie: await sessionCookieHeader() } });
    expect(r.status).toBe(502);
  });
});
