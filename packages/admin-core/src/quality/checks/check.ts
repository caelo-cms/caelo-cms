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
 * sitemap.xml, robots.txt) for plugin-contributed checks.
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
}

export interface PageCheckContext {
  readonly page: StagedPage;
}

export interface SiteCheckContext {
  /** Every published page of the staged build, homepage first. */
  readonly pages: readonly StagedPage[];
}

interface CheckBase {
  /** Stable id; prefixes every rule id it reports (see findings.ts). */
  readonly id: string;
  /** Short operator-readable name ("Page meta tags"). */
  readonly title: string;
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
