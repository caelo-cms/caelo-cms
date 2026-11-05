// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  SECURITY_HEADERS_BUILD_FILE,
  STAGING_PLUGIN_STUB_BODY,
  SVG_DOCUMENT_CSP,
} from "@caelo-cms/shared";
import {
  localBuildSource,
  type StagedOrigin,
  serveStagedBuild,
  stagedKeysFor,
} from "../staged-origin.js";

/** Status of a GET with the path sent byte-for-byte (no URL normalisation). */
function rawStatus(baseUrl: string, path: string): Promise<number> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("stagedKeysFor", () => {
  it("maps site paths to build keys", () => {
    expect(stagedKeysFor("/")).toEqual(["index.html"]);
    expect(stagedKeysFor("/about/")).toEqual(["about/index.html"]);
    expect(stagedKeysFor("/about")).toEqual(["about", "about/index.html"]);
    expect(stagedKeysFor("/_assets/site.css?v=1#x")).toEqual([
      "_assets/site.css",
      "_assets/site.css/index.html",
    ]);
    expect(stagedKeysFor("/caf%C3%A9/")).toEqual(["café/index.html"]);
  });

  it("refuses traversal, backslashes, NUL and broken escapes", () => {
    for (const bad of [
      "/../secret",
      "/a/../../etc/passwd",
      "/%2e%2e/secret",
      "/a/%2E%2E/b",
      "/a\\..\\b",
      "/a%5c..%5cb",
      "/a%00b",
      "/%E0%A4%A",
      "relative",
    ]) {
      expect(stagedKeysFor(bad)).toBeNull();
    }
  });
});

describe("serveStagedBuild over a local build", () => {
  const root = mkdtempSync(join(tmpdir(), "caelo-staged-origin-"));
  const build = join(root, "builds", "run1");
  let origin: StagedOrigin;

  beforeAll(async () => {
    mkdirSync(join(build, "about"), { recursive: true });
    mkdirSync(join(build, "_assets", "fonts", "inter"), { recursive: true });
    writeFileSync(join(build, "index.html"), "<h1>home</h1>");
    writeFileSync(join(build, "about", "index.html"), "<h1>about</h1>");
    writeFileSync(join(build, "favicon.ico"), new Uint8Array([0, 0, 1, 0]));
    writeFileSync(join(build, "_assets", "fonts", "inter", "0123456789abcdef.woff2"), "font");
    writeFileSync(join(build, "_assets", "logo.0123456789abcdef.png"), "png");
    writeFileSync(join(build, "_assets", "mark.0123456789abcdef.svg"), "<svg/>");
    writeFileSync(join(build, "pricing"), "<h1>pricing</h1>");
    writeFileSync(
      join(build, "_content-types.json"),
      JSON.stringify({ pricing: "text/html; charset=utf-8" }),
    );
    writeFileSync(join(root, "secret.txt"), "outside the build");
    symlinkSync(join(root, "secret.txt"), join(build, "leak.txt"));
    origin = await serveStagedBuild(localBuildSource(build));
  });

  afterAll(async () => {
    await origin.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("binds a random loopback port", () => {
    expect(origin.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("serves pages with staging's headers", async () => {
    const res = await fetch(`${origin.baseUrl}/about/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>about</h1>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=86400",
    );
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect((await fetch(`${origin.baseUrl}/`)).status).toBe(200);
  });

  it("compresses text like the CDN does, and leaves binaries alone", async () => {
    const raw = (path: string, acceptEncoding = "gzip, deflate, br") =>
      new Promise<{ encoding?: string; body: Buffer }>((resolve, reject) => {
        const { hostname, port } = new URL(origin.baseUrl);
        const req = request(
          { hostname, port, path, headers: { "Accept-Encoding": acceptEncoding } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({
                ...(res.headers["content-encoding"]
                  ? { encoding: res.headers["content-encoding"] }
                  : {}),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    const page = await raw("/about/");
    expect(page.encoding).toBe("gzip");
    expect(gunzipSync(page.body).toString()).toBe("<h1>about</h1>");
    expect((await raw("/about/", "gzip;q=0, br")).encoding).toBeUndefined();
    expect((await raw("/about/", "br, GZIP;q=0.5")).encoding).toBe("gzip");
    expect((await raw("/favicon.ico")).encoding).toBeUndefined();
    expect((await raw("/_assets/logo.0123456789abcdef.png")).encoding).toBeUndefined();
  });

  it("serves .ico, content-hashed fonts (immutable) and no-extension pages", async () => {
    const ico = await fetch(`${origin.baseUrl}/favicon.ico`);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    const font = await fetch(`${origin.baseUrl}/_assets/fonts/inter/0123456789abcdef.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const bare = await fetch(`${origin.baseUrl}/pricing`);
    expect(bare.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves content-hashed media immutable and never marks a page no-store (#667)", async () => {
    // Lighthouse audits this origin: media under a hashed name must pass
    // "efficient cache lifetimes", and a `no-store` page would fail the
    // back/forward-cache audit.
    const logo = await fetch(`${origin.baseUrl}/_assets/logo.0123456789abcdef.png`);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(logo.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/", "/about/", "/pricing"]) {
      const page = await fetch(`${origin.baseUrl}${path}`);
      expect(page.headers.get("cache-control") ?? "").not.toContain("no-store");
    }
  });

  it("serves SVGs with the sandboxing CSP and everything nosniff, like staging (#891)", async () => {
    const svg = await fetch(`${origin.baseUrl}/_assets/mark.0123456789abcdef.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe(SVG_DOCUMENT_CSP);
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    const page = await fetch(`${origin.baseUrl}/about/`);
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends the build's page headers on documents, so the audit sees its CSP (#1454)", async () => {
    const file = join(build, SECURITY_HEADERS_BUILD_FILE);
    writeFileSync(
      file,
      JSON.stringify(composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS)),
    );
    const own = await serveStagedBuild(localBuildSource(build));
    try {
      const page = await fetch(`${own.baseUrl}/`);
      expect(page.headers.get("content-security-policy-report-only")).toContain(
        "script-src 'self'",
      );
      expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      const logo = await fetch(`${own.baseUrl}/_assets/logo.0123456789abcdef.png`);
      expect(logo.headers.get("content-security-policy-report-only")).toBeNull();
    } finally {
      await own.close();
      rmSync(file);
    }
  });

  it("is read-only and refuses escapes", async () => {
    expect((await fetch(`${origin.baseUrl}/`, { method: "POST" })).status).toBe(405);
    // fetch() would normalise the dot segments away; send the raw path.
    expect(await rawStatus(origin.baseUrl, "/%2e%2e/secret.txt")).toBe(400);
    expect(await rawStatus(origin.baseUrl, "/../secret.txt")).toBe(400);
    // A symlink inside the build that points outside it is not served.
    expect((await fetch(`${origin.baseUrl}/leak.txt`)).status).toBe(404);
    expect((await fetch(`${origin.baseUrl}/missing/`)).status).toBe(404);
    const head = await fetch(`${origin.baseUrl}/about/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("stops listening after close", async () => {
    const other = await serveStagedBuild(localBuildSource(build));
    await other.close();
    await expect(fetch(`${other.baseUrl}/`)).rejects.toThrow();
  });
});

describe("serveStagedBuild: nothing under /api/ leaves the loopback (#1330)", () => {
  let origin: StagedOrigin;

  beforeAll(async () => {
    origin = await serveStagedBuild({
      read: async (key) =>
        key === "index.html" ? { bytes: new Uint8Array([60]), contentType: "text/html" } : null,
    });
  });

  afterAll(async () => {
    await origin.close();
  });

  it("answers plugin calls itself with the staging stub (#1326)", async () => {
    for (const init of [
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: "p1" }),
      },
      { method: "POST", body: new Uint8Array(1024 * 1024 + 1) },
      { method: "GET" },
    ]) {
      const res = await fetch(`${origin.baseUrl}/api/plugin/ratings/summary`, init);
      // 200: the audit browser logs no failed request.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(STAGING_PLUGIN_STUB_BODY);
    }
  });

  it("forwards no other /api/ call, serves the build and refuses build writes", async () => {
    expect((await fetch(`${origin.baseUrl}/api/captcha/challenge`)).status).toBe(404);
    expect((await fetch(`${origin.baseUrl}/`)).status).toBe(200);
    expect((await fetch(`${origin.baseUrl}/`, { method: "POST" })).status).toBe(405);
  });
});
