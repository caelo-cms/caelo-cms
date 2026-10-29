// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  bundledChromiumLaunchOptions,
  handleExternalRoute,
  handleServedRoute,
  type PlaywrightRoute,
  SCREENSHOT_MEMORY_ARGS,
} from "./screenshot.js";

describe("bundledChromiumLaunchOptions", () => {
  it("keeps the back/forward cache on for the Lighthouse audit browser (#667)", () => {
    // Playwright's default --disable-back-forward-cache made Lighthouse's
    // bf-cache audit fail on every page of every site.
    const opts = bundledChromiumLaunchOptions(9333);
    expect(opts.ignoreDefaultArgs).toEqual(["--disable-back-forward-cache"]);
    expect(opts.args).toEqual([
      "--remote-debugging-port=9333",
      "--remote-debugging-address=127.0.0.1",
    ]);
    expect(opts.args?.some((a) => a.includes("back-forward-cache"))).toBe(false);
  });

  it("keeps Playwright's defaults without a DevTools port, locks WebRTC UDP to the proxy and caps memory (screenshots)", () => {
    // PR #869: a rendered page's RTCPeerConnection sent STUN over UDP to a
    // page-chosen internal address; only this switch stops it. The
    // look-alike `--force-webrtc-ip-handling-policy` does NOT.
    // #1217: shm off the small /dev/shm tmpfs, two renderers at most, a
    // capped V8 heap and no caches in the profile.
    expect(bundledChromiumLaunchOptions()).toEqual({
      headless: true,
      channel: "chromium",
      args: ["--webrtc-ip-handling-policy=disable_non_proxied_udp", ...SCREENSHOT_MEMORY_ARGS],
    });
    expect(SCREENSHOT_MEMORY_ARGS).toContain("--disable-dev-shm-usage");
    expect(SCREENSHOT_MEMORY_ARGS).toContain("--renderer-process-limit=2");
    // The Lighthouse browser keeps measuring like a visitor's Chrome.
    expect(bundledChromiumLaunchOptions(9333).args).not.toContain("--disable-dev-shm-usage");
  });
});

describe("handleExternalRoute (SSRF connect-time fulfillment)", () => {
  function mockRoute(url: string, method = "GET", requestHeaders: Record<string, string> = {}) {
    let abortedWith: string | undefined;
    let fulfilledWith:
      | { status: number; headers?: Record<string, string>; body?: Buffer | Uint8Array }
      | undefined;
    let continued = false;
    const route: PlaywrightRoute = {
      request: () => ({
        url: () => url,
        method: () => method,
        headers: () => requestHeaders,
      }),
      abort: async (code) => {
        abortedWith = code ?? "aborted";
      },
      continue: async () => {
        continued = true;
      },
      fulfill: async (opts) => {
        fulfilledWith = opts;
      },
    };
    return {
      route,
      getAborted: () => abortedWith,
      getFulfilled: () => fulfilledWith,
      getContinued: () => continued,
    };
  }

  it("aborts non-GET/HEAD requests on external captures", async () => {
    const m = mockRoute("https://example.com/api", "POST");
    await handleExternalRoute(m.route, { allowedHosts: [] });
    expect(m.getAborted()).toBe("blockedbyclient");
    expect(m.getFulfilled()).toBeUndefined();
    expect(m.getContinued()).toBe(false);
  });

  it("aborts when connect-time DNS resolution returns a private IP (no DNS-rebinding TOCTOU)", async () => {
    const m = mockRoute("http://rebind.example/");
    await handleExternalRoute(m.route, {
      allowedHosts: [],
      lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(m.getAborted()).toBe("blockedbyclient");
    expect(m.getFulfilled()).toBeUndefined();
    expect(m.getContinued()).toBe(false);
  });

  it("fulfills allowed requests via safeExternalFetchBinary and reports redirected finalUrl", async () => {
    let seenFinalUrl: string | undefined;
    const m = mockRoute("https://example.com/start");
    await handleExternalRoute(m.route, {
      allowedHosts: [],
      fetchBinaryFn: async () => ({
        ok: true,
        status: 200,
        contentType: "text/html; charset=utf-8",
        bodyBytes: new TextEncoder().encode("<html><body>ok</body></html>"),
        finalUrl: "https://example.com/landed",
      }),
      onFinalUrl: (_req, finalUrl) => {
        seenFinalUrl = finalUrl;
      },
    });
    expect(m.getAborted()).toBeUndefined();
    expect(m.getFulfilled()?.status).toBe(200);
    expect(Buffer.from(m.getFulfilled()?.body ?? []).toString("utf8")).toContain("ok");
    expect(seenFinalUrl).toBe("https://example.com/landed");
  });

  it("forwards only the browser's identity headers to the guarded fetch, never cookies or credentials", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const m = mockRoute("https://example.com/page", "GET", {
      "user-agent": "Mozilla/5.0 test",
      accept: "text/html",
      "accept-language": "de",
      referer: "https://example.com/",
      cookie: "session=secret",
      authorization: "Bearer secret",
    });
    await handleExternalRoute(m.route, {
      allowedHosts: [],
      fetchBinaryFn: async (_url, opts) => {
        sentHeaders = opts?.headers;
        return {
          ok: true,
          status: 200,
          contentType: "text/html",
          bodyBytes: new Uint8Array(0),
          finalUrl: "https://example.com/page",
        };
      },
    });
    expect(sentHeaders).toEqual({
      "user-agent": "Mozilla/5.0 test",
      accept: "text/html",
      "accept-language": "de",
      referer: "https://example.com/",
    });
  });

  it("never hands a redirect to the browser: the fulfilled response carries no Location", async () => {
    const m = mockRoute("https://example.com/old");
    await handleExternalRoute(m.route, {
      allowedHosts: [],
      fetchBinaryFn: async () => ({
        ok: true,
        status: 200,
        contentType: "text/html",
        bodyBytes: new Uint8Array(0),
        finalUrl: "https://example.com/new",
      }),
    });
    expect(m.getFulfilled()?.headers).toEqual({ "content-type": "text/html" });
    expect(m.getContinued()).toBe(false);
  });
});

describe("handleServedRoute (#1217: a capture served from a hand-over, never the network)", () => {
  function route(url: string, method = "GET") {
    const seen: { aborted?: string; fulfilled?: { status: number; body?: Uint8Array | Buffer } } =
      {};
    const r: PlaywrightRoute = {
      request: () => ({ url: () => url, method: () => method, headers: () => ({}) }),
      abort: async (code) => {
        seen.aborted = code ?? "";
      },
      continue: async () => {
        throw new Error("a served capture never continues to the network");
      },
      fulfill: async (o) => {
        seen.fulfilled = { status: o.status, ...(o.body ? { body: o.body } : {}) };
      },
    };
    return { r, seen };
  }
  const ORIGIN = "https://preview.caelo.invalid";
  const serve = async (u: URL) =>
    u.pathname === "/doc"
      ? {
          status: 200,
          headers: { "content-type": "text/html" },
          body: new TextEncoder().encode("<p>x</p>"),
        }
      : null;

  it("fulfills a same-origin GET from the hand-over", async () => {
    const { r, seen } = route(`${ORIGIN}/doc`);
    await handleServedRoute(r, ORIGIN, serve);
    expect(seen.fulfilled?.status).toBe(200);
    // Playwright under Bun hangs the navigation on a bare Uint8Array body.
    expect(Buffer.isBuffer(seen.fulfilled?.body)).toBe(true);
  });

  it("answers 404 for a same-origin path the hand-over lacks", async () => {
    const { r, seen } = route(`${ORIGIN}/_caelo/media/other`);
    await handleServedRoute(r, ORIGIN, serve);
    expect(seen.fulfilled?.status).toBe(404);
  });

  it("aborts every cross-origin request (metadata server, CDNs, other ports)", async () => {
    for (const url of [
      "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
      "https://cdn.example.com/x.js",
      "https://preview.caelo.invalid:8443/doc",
      "http://127.0.0.1:3000/_caelo/preview-screenshot/x",
    ]) {
      const { r, seen } = route(url);
      await handleServedRoute(r, ORIGIN, serve);
      expect(seen.aborted).toBe("blockedbyclient");
      expect(seen.fulfilled).toBeUndefined();
    }
  });

  it("aborts non-GET/HEAD requests even on its own origin", async () => {
    const { r, seen } = route(`${ORIGIN}/doc`, "POST");
    await handleServedRoute(r, ORIGIN, serve);
    expect(seen.aborted).toBe("blockedbyclient");
  });
});
