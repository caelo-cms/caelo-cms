// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SVG_DOCUMENT_CSP } from "@caelo-cms/shared";
import {
  apiTargetFor,
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

describe("apiTargetFor", () => {
  const api = "https://example.com";

  it("maps /api/ paths onto the gateway origin", () => {
    expect(apiTargetFor("/api/plugin/ratings/summary?x=1", api)).toBe(
      "https://example.com/api/plugin/ratings/summary?x=1",
    );
  });

  it("leaves everything else to the build and never leaves the origin or /api/", () => {
    for (const path of [
      "/",
      "/apixyz",
      "/about/api/x",
      "//evil.example/api/x",
      "/api/../admin",
      "/api/%2e%2e/admin",
    ]) {
      expect(apiTargetFor(path, api)).toBeNull();
    }
  });

  it("keeps a host-looking part of the request on the configured origin", () => {
    for (const path of [
      "/api//evil.example/x",
      "/api/@evil.example/x",
      "/api/x?u=https://evil.example",
    ]) {
      expect(new URL(apiTargetFor(path, api) ?? "").origin).toBe("https://example.com");
    }
  });
});

describe("serveStagedBuild with the gateway behind /api/", () => {
  let gateway: Server;
  let origin: StagedOrigin;
  const seen: { method: string; url: string; body: string; cookie?: string; host?: string }[] = [];

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          cookie: req.headers.cookie,
          host: req.headers.host,
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
        });
        res.end(JSON.stringify({ ok: true, data: { average: 4.5 } }));
      });
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const address = gateway.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    origin = await serveStagedBuild(
      {
        read: async (key) =>
          key === "index.html" ? { bytes: new Uint8Array([60]), contentType: "text/html" } : null,
      },
      { apiOrigin: `http://127.0.0.1:${address.port}` },
    );
  });

  afterAll(async () => {
    await origin.close();
    await new Promise<void>((r) => gateway.close(() => r()));
  });

  it("forwards a plugin POST with its body and cookie and returns the answer unchanged", async () => {
    const res = await fetch(`${origin.baseUrl}/api/plugin/ratings/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "caelo_v=x" },
      body: JSON.stringify({ pageId: "p1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { average: 4.5 } });
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/plugin/ratings/summary",
      body: JSON.stringify({ pageId: "p1" }),
      cookie: "caelo_v=x",
    });
    // The gateway sees its own host, not the loopback's.
    expect(seen.at(-1)?.host).not.toBe(new URL(origin.baseUrl).host);
  });

  it("forwards GETs and still serves the build and refuses build writes", async () => {
    expect((await fetch(`${origin.baseUrl}/api/captcha/challenge`)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/api/captcha/challenge" });
    expect((await fetch(`${origin.baseUrl}/`)).status).toBe(200);
    expect((await fetch(`${origin.baseUrl}/`, { method: "POST" })).status).toBe(405);
  });

  it("refuses a body above the gateway's ceiling without forwarding it", async () => {
    const before = seen.length;
    const res = await fetch(`${origin.baseUrl}/api/plugin/forms/submit`, {
      method: "POST",
      body: new Uint8Array(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(seen.length).toBe(before);
  });
});
