// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { buildRobotsTxt, pageOutputPath } from "./generate.js";

describe("pageOutputPath", () => {
  it("emits index.html for empty/root slugs", () => {
    expect(pageOutputPath("")).toBe("index.html");
    expect(pageOutputPath("/")).toBe("index.html");
    expect(pageOutputPath("home")).toBe("index.html");
    expect(pageOutputPath("index")).toBe("index.html");
  });

  it("emits clean-URL nested paths for non-root slugs", () => {
    expect(pageOutputPath("about")).toBe("about/index.html");
    expect(pageOutputPath("/about/")).toBe("about/index.html");
    expect(pageOutputPath("blog/first-post")).toBe("blog/first-post/index.html");
  });
});

describe("buildRobotsTxt", () => {
  it("blocks all crawlers when noindex (staging requirement)", () => {
    expect(buildRobotsTxt("noindex")).toContain("Disallow: /");
  });

  it("allows crawlers when index (production default)", () => {
    expect(buildRobotsTxt("index")).toContain("Allow: /");
  });
});
