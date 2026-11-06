// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { TRUNCATED_ELEMENTS_PREFIX, TRUNCATED_ELEMENTS_SUFFIX } from "../lighthouse-extract.js";
import { findingOwner, shippedResourcePath, shippedResourcesOf } from "../platform-audits.js";

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
              "Pages whose main resource has cache-control:no-store cannot enter back/forward cache.",
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
    // A browser limitation is neither the site's nor Caelo's: never "fix the module".
    expect(
      findingOwner(
        "bf-cache",
        [{ explanation: "Back/forward cache is disabled due to insufficient memory." }],
        PAGE,
      ),
    ).toBe("check");
  });

  it("never decides from a truncated sample or a subresource no-store", () => {
    const same = { url: "https://staging.example.com/_assets/logo.png" };
    expect(
      findingOwner(
        "cache-insight",
        [same, same, same, same, same, { label: "+3 more flagged item(s) not shown" }],
        PAGE,
      ),
    ).toBe("check");
    expect(
      findingOwner(
        "bf-cache",
        [
          {
            explanation:
              "Pages whose main resource has cache-control:no-store cannot enter back/forward cache.",
          },
        ],
        PAGE,
      ),
    ).toBe("platform");
    expect(
      findingOwner(
        "bf-cache",
        [
          {
            explanation:
              "Some JavaScript network request received resource with Cache-Control: no-store header.",
          },
        ],
        PAGE,
      ),
    ).toBe("check");
  });

  it("has no opinion on ordinary site findings", () => {
    expect(findingOwner("image-alt", [], PAGE)).toBeNull();
    expect(findingOwner("color-contrast", [{ url: "https://cdn.example.net/x" }], PAGE)).toBeNull();
  });
});

describe("#1446 shippedResourcesOf", () => {
  const PAGE = "https://staging.example.test/de/ratgeber";
  const RUNTIME = "/_caelo/plugin/consent-manager/runtime.84de0a18c461.js";

  it("names the shipped file, by path, however the URL is written", () => {
    expect(
      shippedResourcesOf(
        [{ url: `https://staging.example.test${RUNTIME}?v=1` }, { url: RUNTIME }],
        PAGE,
      ),
    ).toEqual([RUNTIME]);
    expect(shippedResourcePath("/_app/immutable/chunks/abc.js", PAGE)).toBe(
      "/_app/immutable/chunks/abc.js",
    );
  });

  it("refuses a file whose name carries no content hash", () => {
    expect(shippedResourcePath("/_caelo/plugin/consent-manager/runtime.js", PAGE)).toBeNull();
  });

  it("refuses what the site chose: media and fonts are hashed but not shipped", () => {
    expect(shippedResourcePath("/_assets/hero.0123456789abcdef.png", PAGE)).toBeNull();
    expect(shippedResourcePath("/_assets/fonts/inter/0123456789abcdef.woff2", PAGE)).toBeNull();
  });

  it("refuses another origin and an unparsable page URL", () => {
    expect(shippedResourcePath(`https://cdn.example.org${RUNTIME}`, PAGE)).toBeNull();
    expect(shippedResourcePath(RUNTIME, "not a url")).toBeNull();
  });

  it("answers null when the finding names anything but shipped files", () => {
    expect(shippedResourcesOf(undefined, PAGE)).toBeNull();
    expect(shippedResourcesOf([], PAGE)).toBeNull();
    // A DOM element, a console message or a reason is about the page.
    expect(shippedResourcesOf([{ url: RUNTIME }, { selector: "img" }], PAGE)).toBeNull();
    expect(shippedResourcesOf([{ url: RUNTIME, explanation: "TypeError" }], PAGE)).toBeNull();
    // Part of the evidence was dropped: never decide from a sample.
    expect(
      shippedResourcesOf(
        [{ url: RUNTIME }, { label: `${TRUNCATED_ELEMENTS_PREFIX}2${TRUNCATED_ELEMENTS_SUFFIX}` }],
        PAGE,
      ),
    ).toBeNull();
  });
});
