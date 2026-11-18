// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stagingLinksForAdmin, stagingOpenRedirect } from "./staging-link.js";

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

describe("stagingLinksForAdmin", () => {
  function withEnv(env: Record<string, string | undefined>, run: () => void): void {
    const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      run();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("goes through Open staging where staging has its own protected host", () => {
    withEnv({ CAELO_PROVIDER: "gcp-firebase" }, () => {
      expect(stagingLinksForAdmin()).toEqual({ kind: "gate" });
    });
  });

  it("uses the local staging port in a development checkout", () => {
    withEnv({ CAELO_PROVIDER: undefined, CAELO_STAGING_BASE_URL: "http://localhost:9999" }, () => {
      expect(stagingLinksForAdmin()).toEqual({ kind: "origin", origin: "http://localhost:9999" });
    });
  });

  it("links nowhere on a provider without a staging site yet", () => {
    withEnv({ CAELO_PROVIDER: "aws" }, () => {
      expect(stagingLinksForAdmin()).toBeNull();
    });
  });
});
