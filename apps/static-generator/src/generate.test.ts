// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { buildRobotsTxt, pageOutputPath, zeroPageBuildError } from "./generate.js";

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

  describe("no-extension mode (v0.2.85)", () => {
    const NONE = { code: "en", urlStrategy: "none" as const, urlHost: null };
    const SUBDIR = { code: "de", urlStrategy: "subdirectory" as const, urlHost: null };

    it("emits bare slug (no extension) for non-home pages", () => {
      expect(pageOutputPath("about", undefined, "no-extension")).toBe("about");
      expect(pageOutputPath("blog/post-1", undefined, "no-extension")).toBe("blog/post-1");
    });

    it("keeps index.html for the home page regardless of style", () => {
      // Home must serve from the bucket root + browsers expect
      // /index.html; the page emits <link rel='canonical' href='/'>
      // so search engines consolidate.
      expect(pageOutputPath("", undefined, "no-extension")).toBe("index.html");
      expect(pageOutputPath("home", undefined, "no-extension")).toBe("index.html");
      expect(pageOutputPath("index", undefined, "no-extension")).toBe("index.html");
    });

    it("locale strategy='none' produces bare slug at root", () => {
      expect(pageOutputPath("about", NONE, "no-extension")).toBe("about");
      expect(pageOutputPath("home", NONE, "no-extension")).toBe("index.html");
    });

    it("locale strategy='subdirectory' prepends the locale prefix to the bare slug", () => {
      expect(pageOutputPath("about", SUBDIR, "no-extension")).toBe("de/about");
      // Home still emits as index.html under the locale prefix
      expect(pageOutputPath("home", SUBDIR, "no-extension")).toBe("de/index.html");
    });

    it("default 'directory' style preserves pre-v0.2.85 behavior", () => {
      expect(pageOutputPath("about")).toBe("about/index.html");
      expect(pageOutputPath("about", undefined, "directory")).toBe("about/index.html");
      expect(pageOutputPath("about", NONE, "directory")).toBe("about/index.html");
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

// Migration run #9 R10 (issue #262) — a full staging/production build
// with zero published pages must fail loudly instead of shipping an
// empty site behind a success toast.
describe("zeroPageBuildError", () => {
  it("fails a full staging build with 0 published pages, pointing at bulk publish", () => {
    const msg = zeroPageBuildError({ pageCount: 0, env: "staging", incremental: false });
    expect(msg).not.toBeNull();
    expect(msg).toContain("0 published pages");
    expect(msg).toContain("set_pages_status_many");
  });

  it("fails a full production build with 0 published pages", () => {
    expect(zeroPageBuildError({ pageCount: 0, env: "production", incremental: false })).toContain(
      "0 published pages",
    );
  });

  it("allows 0 pages on the dev target (unfiltered debugging surface)", () => {
    expect(zeroPageBuildError({ pageCount: 0, env: "dev", incremental: false })).toBeNull();
  });

  it("allows an incremental build matching 0 published pages (draft-edit auto-redeploy)", () => {
    expect(zeroPageBuildError({ pageCount: 0, env: "staging", incremental: true })).toBeNull();
  });

  it("allows any build with at least one page", () => {
    expect(zeroPageBuildError({ pageCount: 1, env: "staging", incremental: false })).toBeNull();
    expect(zeroPageBuildError({ pageCount: 92, env: "production", incremental: false })).toBeNull();
  });
});
