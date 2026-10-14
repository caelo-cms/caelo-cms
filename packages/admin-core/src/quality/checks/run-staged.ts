// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the findings-check half of an audit: read every page of the
 * staged build, run every registered findings check, and shape the result
 * for `quality_audits.record_result`. The audit worker calls it with the
 * staged origin it resolved for Lighthouse.
 */

import { type FetchedPages, fetchStagedPages, type PageToFetch } from "./fetch-pages.js";
import type { ChecksOutcome } from "./outcome.js";
import type { RegisteredCheck } from "./registry.js";
import { runFindingChecks } from "./runner.js";

type FindingsEntry = Extract<RegisteredCheck, { kind: "findings" }>;

/**
 * Run the findings checks over the staged build.
 *
 * @param checks - the registry's findings entries. None: nothing is read.
 * @param pages - every published page with its URL on the staged origin.
 * @param fetcher - injectable for tests.
 */
export async function runChecksOnStagedBuild(
  checks: readonly FindingsEntry[],
  pages: readonly PageToFetch[],
  fetcher: typeof fetch = fetch,
): Promise<ChecksOutcome> {
  const ran = checks.map((c) => ({ id: c.id, title: c.title, scope: c.scope, source: c.source }));
  if (checks.length === 0) return { ran, pages: [], findings: [], errors: [] };
  const fetched: FetchedPages = await fetchStagedPages(pages, fetcher);
  const result = await runFindingChecks(checks, fetched.pages);
  return {
    ran,
    pages: fetched.pages.map((p) => ({ pageId: p.pageId, url: p.url })),
    findings: [...result.findings],
    errors: [
      ...fetched.errors.map((e) => ({
        checkId: null,
        pageId: e.pageId,
        url: e.url,
        code: e.code,
        message: e.message,
      })),
      ...result.errors.map((e) => ({
        checkId: e.checkId,
        ...(e.pageId ? { pageId: e.pageId } : {}),
        code: "check-failed",
        message: e.message,
      })),
    ],
  };
}
