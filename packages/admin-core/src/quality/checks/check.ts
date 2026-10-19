// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the check interface. A check looks at the STAGED build (the
 * one Publish live would ship; maintainer decision: never the live site)
 * and reports findings. It has no write access: fixes stay with the AI's
 * tools, reached through the chat's fix offer.
 *
 * Two scopes:
 * - `page`: `run` is called once per page of the staged build with that
 *   page's rendered HTML. Every finding belongs to that page.
 * - `site`: `run` is called once with every page, for rules that need the
 *   whole set (duplicate titles, orphan pages, …). A finding names the page
 *   it is on, or no page when it is about the site as a whole.
 *
 * The context is deliberately an object so later PRs extend it without
 * reshaping checks: #727 adds the site context (locales, redirects,
 * sitemap.xml, robots.txt) for plugin-contributed checks. #849 adds
 * `build`, so a site check can ask whether the staged build serves a path
 * (the link check resolves every same-site URL against it).
 */

import type { Finding } from "./findings.js";

/** One page of the staged build, as checks read it. */
export interface StagedPage {
  readonly pageId: string;
  /** The page's path on the site (`/`, `/about`). */
  readonly path: string;
  /** The URL it was fetched from on the staged origin. */
  readonly url: string;
  /** The rendered HTML exactly as staging serves it. */
  readonly html: string;
  /**
   * #849 — the site's designated 404 page (#802). It is served at
   * `/404.html` (its `url`), never at its own path, and nothing links to
   * it on purpose.
   */
  readonly notFoundPage?: true;
}

/** What the staged build answers for one path (see {@link StagedBuild}). */
export interface StagedProbe {
  /** True when staging serves the path (2xx after its own redirects). */
  readonly found: boolean;
  /** The final HTTP status staging answered. */
  readonly status: number;
}

/**
 * #849 — read access to the staged build beyond its pages: the origin the
 * pages were fetched from, and a probe for any other path (assets, media,
 * files the generator wrote). Read-only, like every check input.
 */
export interface StagedBuild {
  /** The origin the audit reads the build from (`page.url` lives here). */
  readonly baseUrl: string;
  /**
   * The origin operators know staging by, when it differs from `baseUrl`
   * (gcp-firebase: the preview channel is read, `staging.<domain>` shown).
   */
  readonly displayBaseUrl?: string;
  /**
   * Does the staged build serve `path` (root-relative, percent-encoded as in
   * a URL, no query)? A missing file is `found: false`; staging failing to
   * answer at all throws (the check then fails loudly, never "no findings").
   */
  probe(path: string): Promise<StagedProbe>;
}

export interface PageCheckContext {
  readonly page: StagedPage;
}

export interface SiteCheckContext {
  /** Every published page of the staged build, homepage first. */
  readonly pages: readonly StagedPage[];
  /** #849 — the staged build itself, for paths that are not pages. */
  readonly build: StagedBuild;
}

interface CheckBase {
  /** Stable id; prefixes every rule id it reports (see findings.ts). */
  readonly id: string;
  /** Short operator-readable name ("Page meta tags"). */
  readonly title: string;
  /**
   * #849 — how long one call may take before it counts as hung; the
   * runner's default when absent, never more than its ceiling
   * (runner.ts `MAX_CHECK_CALL_TIMEOUT_MS`). A site check that probes the
   * staged build needs more than a pure one.
   */
  readonly timeoutMs?: number;
}

export interface PageCheck extends CheckBase {
  readonly scope: "page";
  run(ctx: PageCheckContext): readonly Finding[] | Promise<readonly Finding[]>;
}

export interface SiteCheck extends CheckBase {
  readonly scope: "site";
  run(ctx: SiteCheckContext): readonly Finding[] | Promise<readonly Finding[]>;
}

/** A findings check: cheap, runs on every Stage and every page. */
export type QualityCheck = PageCheck | SiteCheck;
