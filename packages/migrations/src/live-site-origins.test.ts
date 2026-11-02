// SPDX-License-Identifier: MPL-2.0

/** #1326 — the live origins the gateway takes plugin posts from. */

import { describe, expect, it } from "bun:test";
import { liveSiteOrigins } from "./public-projection.js";

describe("liveSiteOrigins", () => {
  it("is the base URL's origin plus every public domain, as a browser's Origin", () => {
    expect(
      liveSiteOrigins({
        baseUrl: "https://Example.com:443/blog/",
        publicHosts: ["www.example.com", "example.com"],
        stagingHost: null,
      }),
    ).toEqual(["https://example.com", "https://www.example.com"]);
  });

  it("never includes the staging host, even when it is registered as a domain", () => {
    expect(
      liveSiteOrigins({
        baseUrl: "https://example.com",
        publicHosts: ["staging.example.com"],
        stagingHost: "staging.example.com",
      }),
    ).toEqual(["https://example.com"]);
  });

  it("keeps a local http base URL and drops what is no URL", () => {
    expect(
      liveSiteOrigins({ baseUrl: "http://localhost:8082", publicHosts: [], stagingHost: null }),
    ).toEqual(["http://localhost:8082"]);
    expect(
      liveSiteOrigins({ baseUrl: "not a url", publicHosts: ["bad host"], stagingHost: null }),
    ).toEqual([]);
  });
});
