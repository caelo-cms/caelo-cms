// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stagingOpenRedirect } from "./staging-link.js";

describe("stagingOpenRedirect", () => {
  it("answers 303 to the staging host without caching the one-time link", () => {
    const res = stagingOpenRedirect(
      "https://preview.example.com/_caelo/staging-access?t=abc&path=%2F",
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://preview.example.com/_caelo/staging-access?t=abc&path=%2F",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a non-https or malformed target", () => {
    expect(() => stagingOpenRedirect("http://preview.example.com/x")).toThrow();
    expect(() => stagingOpenRedirect("not a url")).toThrow();
  });

  it("is what /staging/open uses — SvelteKit's redirect() 500s on another origin", () => {
    const route = readFileSync(
      resolve(import.meta.dir, "../../routes/(authed)/staging/open/+server.ts"),
      "utf8",
    );
    expect(route).toContain("stagingOpenRedirect(");
    expect(route).not.toMatch(/\bredirect\(/);
  });
});
