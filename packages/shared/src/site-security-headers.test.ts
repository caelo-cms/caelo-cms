// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeSiteHeaders,
  cspOriginSchema,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  emitCaddySiteHeaders,
  enforceBlockers,
  gcpBackendBucketHeaders,
  parseSiteHeaderSet,
  SITE_DOCUMENT_PATH_PATTERN,
  SITE_HEADERS_MAX_BYTES,
  type SiteCspFacts,
  SiteHeadersTooLargeError,
  siteSecurityPolicySchema,
} from "./site-security-headers.js";
import { SVG_PATH_PATTERN } from "./static-security-headers.js";

const FACTS: SiteCspFacts = {
  ...EMPTY_CSP_FACTS,
  origins: {
    script: ["https://cdn.vendor.com"],
    frame: ["https://www.youtube-nocookie.com"],
    img: ["https://media.example.com"],
  },
  inlineScriptHashes: ["'sha256-abc='"],
};

const manyHashes = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `'sha256-${String(i).padStart(43, "0")}='`);

describe("composeSiteHeaders", () => {
  it("report_only: the full CSP only reports; what cannot break a script is enforced", () => {
    const { headers } = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, FACTS);
    expect(headers["Content-Security-Policy"]).toBe(
      "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
    );
    const report = headers["Content-Security-Policy-Report-Only"] ?? "";
    expect(report).toContain("script-src 'self' 'sha256-abc=' https://cdn.vendor.com");
    expect(report).toContain("frame-src 'self' https://www.youtube-nocookie.com");
    expect(report).toContain("img-src 'self' data: blob: https://media.example.com");
  });

  it("no script-src of any mode carries unsafe-inline or unsafe-eval", () => {
    for (const cspMode of ["report_only", "enforce"] as const) {
      const { headers } = composeSiteHeaders({ ...DEFAULT_SITE_SECURITY_POLICY, cspMode }, FACTS);
      const csp =
        headers["Content-Security-Policy-Report-Only"] ?? headers["Content-Security-Policy"] ?? "";
      expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("unsafe");
    }
  });

  it("enforce: one CSP, nothing report-only left", () => {
    const { headers } = composeSiteHeaders(
      { ...DEFAULT_SITE_SECURITY_POLICY, cspMode: "enforce" },
      FACTS,
    );
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(headers["Content-Security-Policy"]).toContain("script-src 'self'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
  });

  it("safe defaults on every install", () => {
    const { headers, hsts } = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS);
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
    // Video embeds rely on these.
    expect(headers["Permissions-Policy"]).not.toContain("autoplay");
    expect(headers["Permissions-Policy"]).not.toContain("fullscreen");
    expect(hsts).toBe("max-age=31536000");
  });

  it("a listed frame ancestor drops X-Frame-Options, which cannot say it", () => {
    const { headers } = composeSiteHeaders(
      { ...DEFAULT_SITE_SECURITY_POLICY, frameAncestors: ["https://partner.example.com"] },
      EMPTY_CSP_FACTS,
    );
    expect(headers["X-Frame-Options"]).toBeUndefined();
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'self' https://partner.example.com",
    );
  });

  it("an allowed feature is self-only, and extra sources join the derived ones", () => {
    const { headers } = composeSiteHeaders(
      {
        ...DEFAULT_SITE_SECURITY_POLICY,
        allowedFeatures: ["geolocation"],
        extraSources: { connect: ["https://api.vendor.com"] },
      },
      EMPTY_CSP_FACTS,
    );
    expect(headers["Permissions-Policy"]).toContain("geolocation=(self)");
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "connect-src 'self' https://api.vendor.com",
    );
  });

  it("a document with an object keeps it; max-age 0 sends no HSTS", () => {
    const set = composeSiteHeaders(
      {
        ...DEFAULT_SITE_SECURITY_POLICY,
        hsts: { maxAgeSeconds: 0, includeSubdomains: false, preload: false },
      },
      { ...EMPTY_CSP_FACTS, objectOrigins: ["https://pdf.example.com"] },
    );
    expect(set.headers["Content-Security-Policy"]).toContain("object-src https://pdf.example.com");
    expect(set.hsts).toBeNull();
  });
});

describe("the header budget", () => {
  const facts = { ...EMPTY_CSP_FACTS, inlineScriptHashes: manyHashes(200) };

  it("enforce refuses a policy that does not fit, naming the way out", () => {
    expect(() =>
      composeSiteHeaders({ ...DEFAULT_SITE_SECURITY_POLICY, cspMode: "enforce" }, facts),
    ).toThrow(SiteHeadersTooLargeError);
  });

  it("report_only keeps the site building and says so", () => {
    const set = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, facts);
    expect(set.cspCut).toBe(true);
    expect(set.headers["Content-Security-Policy-Report-Only"]).not.toContain("sha256");
    expect(enforceBlockers(set)).toContain("the full CSP does not fit a response header");
  });

  it("report_only with too many origins drops the report-only header, keeps the baseline", () => {
    const origins = Array.from({ length: 400 }, (_, i) => `https://host${i}.example.com`);
    const set = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, {
      ...EMPTY_CSP_FACTS,
      origins: { img: origins },
    });
    expect(set.cspCut).toBe(true);
    expect(set.headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(set.headers["Content-Security-Policy"]).toContain("frame-ancestors");
    const bytes = Object.entries(set.headers).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(bytes).toBeLessThanOrEqual(SITE_HEADERS_MAX_BYTES);
  });
});

describe("SITE_DOCUMENT_PATH_PATTERN", () => {
  const doc = new RegExp(SITE_DOCUMENT_PATH_PATTERN);
  const svg = new RegExp(SVG_PATH_PATTERN);

  it.each([
    "/",
    "/about",
    "/about/",
    "/about.html",
    "/a",
    "/ap",
    "/apiary",
    "/apiary/x",
    "/api.html",
    "/de/produkte/",
    "/de/produkte",
    "/de/produkte.html",
    "/v1.2/notes/",
  ])("%s is a document", (path) => {
    expect(doc.test(path)).toBe(true);
  });

  it.each([
    "/api",
    "/api/",
    "/api/plugin/forms/submit",
    "/_assets/x.0123456789abcdef.js",
    "/_caelo/plugin/a/b.js",
    "/robots.txt",
    "/sitemap.xml",
    "/logo.svg",
    "/a/logo.SVG",
    "/favicon.ico",
    "/data/ips.json",
  ])("%s is not", (path) => {
    expect(doc.test(path)).toBe(false);
  });

  it("no path matches both it and the SVG entry (Firebase names no winner)", () => {
    for (const path of ["/x.svg", "/a/b.svg", "/x.SVG", "/x.svg/", "/x.svg.html", "/a.b/c.svg"]) {
      expect(doc.test(path) && svg.test(path)).toBe(false);
    }
  });

  it("uses no RE2-forbidden syntax", () => {
    expect(SITE_DOCUMENT_PATH_PATTERN).not.toMatch(/\(\?[=!<]/);
  });
});

describe("host forms", () => {
  const set = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, FACTS);

  it("Caddy: on documents only, HSTS included, quoted", () => {
    const snippet = emitCaddySiteHeaders(set);
    expect(snippet).toContain("not path /api/* /_*");
    expect(snippet).toContain("not path *.svg");
    expect(snippet).toContain('header @caelo_documents Referrer-Policy "strict-origin-when');
    expect(snippet).toContain('header @caelo_documents Strict-Transport-Security "max-age=');
    expect(set.headers["Content-Security-Policy-Report-Only"]).not.toContain('"');
  });

  it("gcp: nosniff first, one Name: value per header", () => {
    const list = gcpBackendBucketHeaders(set);
    expect(list[0]).toBe("X-Content-Type-Options: nosniff");
    expect(list).toContain("X-Frame-Options: SAMEORIGIN");
    expect(list).toContain("Strict-Transport-Security: max-age=31536000");
  });

  it("a build file round-trips", () => {
    expect(parseSiteHeaderSet(JSON.stringify(set))).toEqual(set);
  });
});

describe("the policy", () => {
  it.each([
    "'unsafe-inline'",
    "'unsafe-eval'",
    "*",
    "data:",
    "https:",
    "http://example.com",
    "https://example.com/path",
    "https://Example.com",
    "https://example.com; script-src *",
  ])("refuses %s as an origin", (value) => {
    expect(cspOriginSchema.safeParse(value).success).toBe(false);
  });

  it.each(["https://example.com", "https://*.example.com", "wss://a.example.com:8443"])(
    "takes %s",
    (value) => {
      expect(cspOriginSchema.safeParse(value).success).toBe(true);
    },
  );

  it("the migration stores DEFAULT_SITE_SECURITY_POLICY", () => {
    const sql = readFileSync(
      resolve(
        import.meta.dir,
        "../../migrations/migrations/cms_admin/0639_site_security_headers.sql",
      ),
      "utf8",
    );
    const stored = sql.match(/DEFAULT '(\{[\s\S]*?\})'::jsonb/)?.[1];
    expect(siteSecurityPolicySchema.parse(JSON.parse(stored ?? ""))).toEqual(
      DEFAULT_SITE_SECURITY_POLICY,
    );
  });
});
