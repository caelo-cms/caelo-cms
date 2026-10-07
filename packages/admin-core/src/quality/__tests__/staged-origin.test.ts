// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
