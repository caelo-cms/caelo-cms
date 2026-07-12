// SPDX-License-Identifier: MPL-2.0

/**
 * issue #191 — adversarial SSRF-guard suite (CLAUDE.md §6: attempts to
 * escape a sandbox belong in the tests and must fail). Every case here
 * is an attack shape: metadata endpoints, RFC1918, decimal/mapped IP
 * forms, redirect laundering, and DNS answers that point inside.
 */

import { describe, expect, it } from "bun:test";
import { crawlSite } from "./crawler.js";
import {
  assertPublicHttpUrl,
  ExternalUrlBlockedError,
  isExternalUrlBlockedError,
  isPublicIpAddress,
  safeExternalFetch,
  safeExternalFetchBinary,
} from "./safe-fetch.js";

describe("isPublicIpAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.5",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "192.0.0.5",
    "192.0.2.1", // TEST-NET-1
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7", // TEST-NET-2
    "203.0.113.9", // TEST-NET-3
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1", // v4-mapped loopback
    "::ffff:10.0.0.1",
    "::ffff:192.168.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", // NAT64-embedded loopback
    "not-an-ip",
    "",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255", // just below CGNAT
    "100.128.0.0", // just above CGNAT
    "172.15.255.255",
    "172.32.0.1",
    "192.0.1.1",
    "198.17.255.255",
    "198.20.0.1",
    "9.9.9.9",
    "2600:1901::1",
    "2a00:1450:4001:829::200e",
    "::ffff:8.8.8.8", // v4-mapped public stays public
  ];
  it.each(blocked)("blocks %s", (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false);
  });
  it.each(allowed)("allows %s", (ip) => {
    expect(isPublicIpAddress(ip)).toBe(true);
  });
});

describe("assertPublicHttpUrl — static pre-checks", () => {
  const blockedUrls = [
    "ftp://example.com/",
    "file:///etc/passwd",
    "gopher://example.com/",
    "http://localhost/",
    "http://sub.localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.0.1/admin",
    "http://example.com:8080/", // non-default port
    "http://example.com:22/",
    "not a url",
  ];
  it.each(blockedUrls)("blocks %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(ExternalUrlBlockedError);
  });

  it("normalises decimal IPv4 forms before judging (http://2130706433 → 127.0.0.1)", () => {
    // WHATWG URL parses decimal/hex hosts into dotted-quad IPv4 — the
    // guard must see through the disguise. If the runtime ever stops
    // normalising, the DNS-lookup guard is the backstop; this test
    // pins the cheap path.
    const u = new URL("http://2130706433/");
    expect(u.hostname).toBe("127.0.0.1");
    expect(() => assertPublicHttpUrl("http://2130706433/")).toThrow(ExternalUrlBlockedError);
    expect(() => assertPublicHttpUrl("http://0x7f000001/")).toThrow(ExternalUrlBlockedError);
  });

  it("allows plain public URLs and allowedHosts exemptions", () => {
    expect(assertPublicHttpUrl("https://example.com/page").hostname).toBe("example.com");
    expect(
      assertPublicHttpUrl("http://127.0.0.1:39999/fixture", {
        allowedHosts: ["127.0.0.1"],
      }).port,
    ).toBe("39999");
  });

  it("error message names the URL and the reason (AI-actionable)", () => {
    try {
      assertPublicHttpUrl("http://169.254.169.254/");
      expect.unreachable();
    } catch (e) {
      expect(isExternalUrlBlockedError(e)).toBe(true);
      expect((e as Error).message).toContain("169.254.169.254");
      expect((e as Error).message).toContain("not publicly routable");
    }
  });
});

describe("safeExternalFetch — connect-time DNS guard", () => {
  it("refuses a hostname whose DNS answer is private (validation inside the lookup)", async () => {
    // The lookupFn stands in for a rebinding resolver: whatever any
    // pre-check saw, the CONNECTION resolves to 10.0.0.5 — and because
    // the validation runs inside that resolution, the socket never opens.
    await expect(
      safeExternalFetch("http://rebind.example/", {
        lookupFn: async () => [{ address: "10.0.0.5", family: 4 }],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/non-public address.*10\.0\.0\.5/);
  });

  it("refuses a mixed public+private DNS answer outright", async () => {
    await expect(
      safeExternalFetch("http://mixed.example/", {
        lookupFn: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "192.168.1.1", family: 4 },
        ],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/non-public address/);
  });

  it("serves an allowed local fixture and enforces the redirect re-validation", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/ok") {
          return new Response("<html><title>hi</title></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        if (path === "/to-metadata") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        if (path === "/to-ok") {
          return new Response(null, { status: 302, headers: { location: "/ok" } });
        }
        return new Response("nope", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const allowedHosts = ["127.0.0.1"];
    try {
      const ok = await safeExternalFetch(`${base}/ok`, { allowedHosts });
      expect(ok.ok).toBe(true);
      expect(ok.bodyText).toContain("<title>hi</title>");

      const sameHost = await safeExternalFetch(`${base}/to-ok`, { allowedHosts });
      expect(sameHost.ok).toBe(true);
      expect(sameHost.finalUrl).toBe(`${base}/ok`);

      // Redirect laundering: hop 1 is allowed (fixture), hop 2 targets
      // the metadata endpoint — the hop is re-validated and blocked
      // BEFORE any connection.
      await expect(safeExternalFetch(`${base}/to-metadata`, { allowedHosts })).rejects.toThrow(
        ExternalUrlBlockedError,
      );
    } finally {
      server.stop(true);
    }
  });

  it("safeExternalFetchBinary round-trips raw bytes without a UTF-8 mangle (#249)", async () => {
    // 0x89 0x50 0x4e 0x47 (PNG magic) + invalid-UTF8 tail — a text
    // decode/encode round-trip would corrupt these bytes.
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(payload, { headers: { "content-type": "image/png" } });
      },
    });
    try {
      const res = await safeExternalFetchBinary(`http://127.0.0.1:${server.port}/img.png`, {
        allowedHosts: ["127.0.0.1"],
      });
      expect(res.ok).toBe(true);
      expect(res.contentType).toBe("image/png");
      expect([...res.bodyBytes]).toEqual([...payload]);
    } finally {
      server.stop(true);
    }
  });

  it("aborts when the response exceeds maxBytes instead of truncating", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("x".repeat(64 * 1024), {
          headers: { "content-type": "text/html" },
        });
      },
    });
    try {
      await expect(
        safeExternalFetch(`http://127.0.0.1:${server.port}/`, {
          allowedHosts: ["127.0.0.1"],
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/byte cap/);
    } finally {
      server.stop(true);
    }
  });
});

describe("crawler — root-blocked crawls fail loudly", () => {
  it("throws (not empty-result) when the source URL itself is blocked", async () => {
    await expect(crawlSite({ sourceUrl: "http://169.254.169.254/latest/" })).rejects.toThrow(
      ExternalUrlBlockedError,
    );
  });

  it("records (not throws) blocked in-site links discovered mid-crawl", async () => {
    // Fetcher injection bypasses the real guard; simulate a page whose
    // link fetch raises a block — only the root may escalate.
    let call = 0;
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      fetcher: async (url) => {
        call += 1;
        if (call === 1) {
          return {
            ok: true,
            html: '<html><a href="/inner">x</a></html>',
            contentType: "text/html",
          };
        }
        throw new ExternalUrlBlockedError(url, "test block");
      },
      throttleMs: 0,
    });
    expect(result.pages).toHaveLength(1);
    expect(result.errors.some((e) => e.reason.includes("test block"))).toBe(true);
  });
});
