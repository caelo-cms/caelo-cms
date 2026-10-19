// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  bundledChromiumLaunchOptions,
  handleExternalRoute,
  type PlaywrightRoute,
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

  it("leaves Playwright's defaults alone without a DevTools port (screenshots)", () => {
    expect(bundledChromiumLaunchOptions()).toEqual({ headless: true, channel: "chromium" });
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
