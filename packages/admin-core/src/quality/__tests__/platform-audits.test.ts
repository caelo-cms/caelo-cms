// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { findingOwner } from "../platform-audits.js";

const PAGE = "https://staging.example.com/about/";

describe("findingOwner (#667)", () => {
  it("treats the document's delivery as platform", () => {
    for (const id of ["document-latency-insight", "server-response-time", "redirects"]) {
      expect(findingOwner(id, [], PAGE)).toBe("platform");
    }
  });

  it("decides caching / compression by whose files are flagged", () => {
    const same = { url: "https://staging.example.com/_assets/logo.png" };
    const third = { url: "https://cdn.example.net/widget.js" };
    expect(findingOwner("cache-insight", [same, { url: "/_assets/x.css" }], PAGE)).toBe("platform");
    expect(findingOwner("uses-text-compression", [third], PAGE)).toBe("site");
    expect(findingOwner("uses-long-cache-ttl", [same, third], PAGE)).toBe("check");
    expect(findingOwner("uses-http2", [], PAGE)).toBe("check");
  });

  it("decides the back/forward cache by the reasons", () => {
    expect(
      findingOwner(
        "bf-cache",
        [{ explanation: "Back/forward cache is disabled by the command line." }],
        PAGE,
      ),
    ).toBe("platform");
    expect(
      findingOwner(
        "bf-cache",
        [
          {
            explanation:
              "Pages with cache-control:no-store header cannot enter back/forward cache.",
          },
        ],
        PAGE,
      ),
    ).toBe("platform");
    expect(
      findingOwner(
        "bf-cache",
        [{ explanation: "The page has an unload handler in the main frame." }],
        PAGE,
      ),
    ).toBe("site");
    expect(findingOwner("bf-cache", [], PAGE)).toBe("check");
  });

  it("has no opinion on ordinary site findings", () => {
    expect(findingOwner("image-alt", [], PAGE)).toBeNull();
    expect(findingOwner("color-contrast", [{ url: "https://cdn.example.net/x" }], PAGE)).toBeNull();
  });
});
