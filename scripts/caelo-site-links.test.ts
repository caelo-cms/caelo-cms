// SPDX-License-Identifier: MPL-2.0

/**
 * Links into caelo-cms.com stay inside the site's stable sections (#807).
 *
 * When `docs-site/` was deleted (#787), product code and the install repo
 * kept linking its old paths (`/install-gcp`, `/mcp`, …); only redirects on
 * the site kept them working. Every link the repo ships now points at one
 * of the sections below, so the next move of a page inside them is the
 * site's redirect job, and a link to a path outside them fails here.
 *
 * Subdomains (`telemetry.caelo-cms.com`) are services, not pages, and are
 * out of scope. The changelog and the phase plans are historical records
 * and are not scanned (same rule as docs-links.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * The site sections a link may point into — derived from the links the
 * repo shipped when this test was added (every one answers 200): the docs,
 * the privacy and security pages, the hosting page. Add a section here only
 * when the site has it as a stable top-level path.
 */
const ALLOWED_SITE_SECTIONS = ["/docs", "/privacy", "/security", "/hosting"] as const;

/** `caelo-cms.com` or `www.caelo-cms.com` (not a subdomain), then an optional path. */
const SITE_LINK =
  /(?<![\w.@-])(?:https?:\/\/)?(?:www\.)?caelo-cms\.com(\/[^\s"'`<>()[\]{}|\\^]*)?/g;

/** The path of every caelo-cms.com link in `text` that is outside the allowed sections. */
function strandedSiteLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SITE_LINK)) {
    const path = (m[1] ?? "").replace(/[#?].*$/, "").replace(/[.,;:!]+$/, "");
    if (path === "" || path === "/") continue;
    const allowed = ALLOWED_SITE_SECTIONS.some((s) => path === s || path.startsWith(`${s}/`));
    if (!allowed) out.push(path);
  }
  return out;
}

const HISTORICAL = [/^CHANGELOG\.md$/, /^plans\//];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  "dist",
  "build",
  "coverage",
  ".claude",
]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".svelte",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".sh",
  ".html",
  ".txt",
  ".sql",
  ".toml",
]);
/** This file names stranded paths on purpose. */
const SELF = relative(REPO_ROOT, import.meta.path);

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(full));
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) out.push(relative(REPO_ROOT, full));
  }
  return out;
}

describe("strandedSiteLinks", () => {
  it("accepts the site root and every allowed section, with anchors and sentence punctuation", () => {
    expect(
      strandedSiteLinks(
        [
          "https://caelo-cms.com",
          "https://caelo-cms.com/",
          "see https://caelo-cms.com/docs/mcp/.",
          "[caelo-cms.com/docs](https://caelo-cms.com/docs/)",
          "https://www.caelo-cms.com/docs/install/google-cloud/#dns",
          "https://caelo-cms.com/privacy/ https://caelo-cms.com/security/ https://caelo-cms.com/hosting/",
          "security@caelo-cms.com",
          "https://telemetry.caelo-cms.com/v1/install",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("names the old docs-site paths and anything else outside the sections", () => {
    expect(
      strandedSiteLinks(
        "https://caelo-cms.com/install-gcp#common-issues, https://caelo-cms.com/mcp and caelo-cms.com/docsearch",
      ),
    ).toEqual(["/install-gcp", "/mcp", "/docsearch"]);
  });
});

describe("caelo-cms.com links in the repo (#807)", () => {
  it("point only into the site's stable sections", () => {
    const stranded: string[] = [];
    for (const file of textFiles(REPO_ROOT)) {
      if (file === SELF || HISTORICAL.some((h) => h.test(file))) continue;
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const path of strandedSiteLinks(text)) stranded.push(`${file}: caelo-cms.com${path}`);
    }
    expect(stranded).toEqual([]);
  });
});
