// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildRobotsTxt,
  missingRootPageError,
  pageOutputPath,
  zeroPageBuildError,
} from "./generate.js";

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

  describe("no-extension mode (v0.2.85)", () => {
    it("emits bare slug (no extension) for non-home pages", () => {
      expect(pageOutputPath("about", "no-extension")).toBe("about");
      expect(pageOutputPath("blog/post-1", "no-extension")).toBe("blog/post-1");
    });

    it("keeps index.html for the home page regardless of style", () => {
      // Home must serve from the bucket root + browsers expect
      // /index.html; the page emits <link rel='canonical' href='/'>
      // so search engines consolidate.
      expect(pageOutputPath("", "no-extension")).toBe("index.html");
      expect(pageOutputPath("home", "no-extension")).toBe("index.html");
      expect(pageOutputPath("index", "no-extension")).toBe("index.html");
    });

    it("default 'directory' style preserves pre-v0.2.85 behavior", () => {
      expect(pageOutputPath("about")).toBe("about/index.html");
      expect(pageOutputPath("about", "directory")).toBe("about/index.html");
    });
  });

  describe("explicit homepage designation (0184)", () => {
    it("a page designated home on a NON-magic slug emits at the site root", () => {
      // Without the flag `landing` is a normal nested page...
      expect(pageOutputPath("landing")).toBe("landing/index.html");
      // ...with the designation it emits at the bucket root, so it is
      // actually served at `/` (matching its canonical).
      expect(pageOutputPath("landing", "directory", true)).toBe("index.html");
      expect(pageOutputPath("landing", "no-extension", true)).toBe("index.html");
    });

    it("a normal (non-designated) page is unaffected", () => {
      expect(pageOutputPath("about", "directory", false)).toBe("about/index.html");
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

// issue #302 (run #14 finding) — a build where no page lands at the bucket
// root ships a site whose `/` 404s. The migration flow built the homepage
// under a source-derived slug and nothing failed; this guard makes it loud.
describe("missingRootPageError", () => {
  it("REGRESSION run #14: fails a staging build whose homepage has a source-derived slug", () => {
    const msg = missingRootPageError({
      outputPaths: ["startseite/index.html", "pricing/index.html", "blog/a/index.html"],
      rootEligibleSlugs: ["startseite", "pricing", "blog/a"],
      env: "staging",
      incremental: false,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("no page serves the site root");
    // The message carries the next step for the AI (CLAUDE.md §11).
    expect(msg).toContain("update_pages_many");
    expect(msg).toContain("'home'");
  });

  it("passes when the homepage slug is 'home' (emitted at index.html)", () => {
    expect(
      missingRootPageError({
        outputPaths: ["index.html", "pricing/index.html"],
        rootEligibleSlugs: ["home", "pricing"],
        env: "production",
        incremental: false,
      }),
    ).toBeNull();
  });

  it("skips dev builds and incremental builds", () => {
    const args = {
      outputPaths: ["about/index.html"],
      rootEligibleSlugs: ["about"],
    } as const;
    expect(missingRootPageError({ ...args, env: "dev", incremental: false })).toBeNull();
    expect(missingRootPageError({ ...args, env: "staging", incremental: true })).toBeNull();
  });

  it("skips when no page could claim the root (all locales prefixed)", () => {
    expect(
      missingRootPageError({
        outputPaths: ["de/index.html", "fr/index.html"],
        rootEligibleSlugs: [],
        env: "production",
        incremental: false,
      }),
    ).toBeNull();
  });

  it("caps the slug sample at 10 entries", () => {
    const slugs = Array.from({ length: 15 }, (_, i) => `page-${i}`);
    const msg = missingRootPageError({
      outputPaths: slugs.map((s) => `${s}/index.html`),
      rootEligibleSlugs: slugs,
      env: "staging",
      incremental: false,
    });
    expect(msg).toContain("page-9");
    expect(msg).not.toContain("page-10");
    expect(msg).toContain(", …");
  });
});
