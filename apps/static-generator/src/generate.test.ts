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

  describe("locale-aware emission (P9 review pass)", () => {
    const NONE = { code: "en", urlStrategy: "none" as const, urlHost: null };
    const SUBDIR = { code: "de", urlStrategy: "subdirectory" as const, urlHost: null };
    const SUBDOMAIN = {
      code: "de",
      urlStrategy: "subdomain" as const,
      urlHost: "de.example.com",
    };
    const DOMAIN = { code: "de", urlStrategy: "domain" as const, urlHost: "example.de" };

    it("strategy=none keeps the bare path", () => {
      expect(pageOutputPath("about", NONE)).toBe("about/index.html");
      expect(pageOutputPath("home", NONE)).toBe("index.html");
    });

    it("strategy=subdirectory prefixes the locale code", () => {
      expect(pageOutputPath("about", SUBDIR)).toBe("de/about/index.html");
      expect(pageOutputPath("home", SUBDIR)).toBe("de/index.html");
    });

    it("strategy=subdomain emits under _hosts/<host>", () => {
      expect(pageOutputPath("about", SUBDOMAIN)).toBe("_hosts/de.example.com/about/index.html");
      expect(pageOutputPath("home", SUBDOMAIN)).toBe("_hosts/de.example.com/index.html");
    });

    it("strategy=domain emits under _hosts/<host>", () => {
      expect(pageOutputPath("about", DOMAIN)).toBe("_hosts/example.de/about/index.html");
    });

    it("strategy=subdomain throws when url_host missing", () => {
      expect(() =>
        pageOutputPath("about", { code: "de", urlStrategy: "subdomain", urlHost: null }),
      ).toThrow(/url_host/);
    });

    it("emission is collision-free across locales for the same slug", () => {
      const en = pageOutputPath("home", NONE);
      const de = pageOutputPath("home", SUBDIR);
      expect(en).not.toBe(de);
    });
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
