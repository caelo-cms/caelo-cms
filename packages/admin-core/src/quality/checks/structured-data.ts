// SPDX-License-Identifier: MPL-2.0

/**
 * #1753 — the core `structured-data` check: the integrity of every staged
 * page's JSON-LD, read as one graph per page (a search engine resolves
 * `@id`s across a page's blocks).
 *
 * Core writes one graph per page with fixed `@id`s and refuses a plugin's
 * dangling reference while it builds it (shared `json-ld.ts`), so what this
 * check finds on core's own output is a fault; what it mostly finds is
 * structured data a module's markup carries next to core's graph. It runs
 * on the HTML Publish live would ship, so neither can slip through.
 *
 * Objective rules only (epic #1751):
 *   - `structured-data/invalid-json`  error   a block a JSON parser refuses
 *   - `structured-data/graph-missing` error   no block holds core's `@graph`
 *   - `structured-data/dangling-id`   error   a reference naming no node of the page
 *   - `structured-data/duplicate-id`  error   two nodes with one `@id`
 *   - `structured-data/extra-block`   warning more blocks than core's one
 *   - `structured-data/not-checked`   warning blocks too large to read
 *
 * Type-specific rules (required properties, values matching the visible
 * text) are the `seo` plugin's.
 */

import { type JsonLdBlock, type JsonLdProblem, jsonLdIntegrityProblems } from "@caelo-cms/shared";
import type { SiteCheck, StagedPage } from "./check.js";
import type { Finding } from "./findings.js";
import { extractPageFacts } from "./page-facts.js";

export const STRUCTURED_DATA_CHECK_ID = "structured-data";

/** The JSON-LD blocks of a staged page, read the way plugin checks get them (#1755). */
export function jsonLdBlocksOf(page: StagedPage): {
  readonly blocks: readonly JsonLdBlock[];
  /** The modules that carry a block of their own. */
  readonly moduleIds: readonly string[];
} {
  const facts = extractPageFacts(page, new Set(), "no-sitemap");
  const moduleIds = [
    ...new Set(facts.jsonLd.flatMap((b) => (b.moduleId === null ? [] : [b.moduleId]))),
  ];
  return { blocks: facts.jsonLd, moduleIds };
}

/** Where a page's extra or broken JSON-LD sits, for the fix. */
function inModules(moduleIds: readonly string[]): string {
  return moduleIds.length > 0 ? ` (module ${moduleIds.join(", ")})` : "";
}

const MODULE_HINT =
  "remove the hand-written <script type=\"application/ld+json\"> from the module's html; the page's structured data comes from its page type (the seo plugin's schema mapping), which core writes into the page's one graph";

/** The finding of one problem on one page. */
function findingOf(
  page: StagedPage,
  problem: JsonLdProblem,
  moduleIds: readonly string[],
): Finding {
  const ruleId = `${STRUCTURED_DATA_CHECK_ID}/${problem.rule}`;
  const where = inModules(moduleIds);
  const moduleFix =
    moduleIds.length > 0 ? { tool: "update_modules_many", hint: MODULE_HINT } : undefined;
  switch (problem.rule) {
    case "invalid-json":
      return {
        ruleId,
        severity: "error",
        pageId: page.pageId,
        message: `Broken structured data: a JSON-LD block is not valid JSON${where} (${problem.detail.slice(0, 200)}). Search engines ignore the whole block.`,
        ...(moduleFix ? { fix: moduleFix } : {}),
      };
    case "graph-missing":
      return {
        ruleId,
        severity: "error",
        pageId: page.pageId,
        message:
          "No structured data graph: the page carries none of the JSON-LD core writes into every page. This is a fault in Caelo; report it with bug_report.",
        fix: { tool: "bug_report", hint: "report the page and that its JSON-LD graph is missing" },
      };
    case "dangling-id":
      return {
        ruleId,
        severity: "error",
        pageId: page.pageId,
        message: `Structured data points nowhere: ${problem.ids.slice(0, 5).join(", ")} ${problem.ids.length === 1 ? "is" : "are"} referenced by @id but no node of the page has that id${where}. Search engines drop the link between the nodes.`,
        fix: moduleFix ?? {
          tool: "get_plugin",
          hint: "the reference comes from a plugin's structured data: read its health and fix its mapping",
        },
      };
    case "duplicate-id":
      return {
        ruleId,
        severity: "error",
        pageId: page.pageId,
        message: `Structured data twice: ${problem.ids.slice(0, 5).join(", ")} ${problem.ids.length === 1 ? "is" : "are"} defined by more than one node${where}. One node per @id: search engines cannot tell which one is meant.`,
        ...(moduleFix ? { fix: moduleFix } : {}),
      };
    case "extra-block":
      return {
        ruleId,
        severity: "warning",
        pageId: page.pageId,
        message: `Extra structured data: the page carries ${problem.count} JSON-LD block${problem.count === 1 ? "" : "s"} next to core's graph${where}. Hand-written blocks duplicate or contradict the graph.`,
        ...(moduleFix ? { fix: moduleFix } : {}),
      };
    case "not-checked":
      return {
        ruleId,
        severity: "warning",
        pageId: page.pageId,
        message: `Structured data not checked: the page's JSON-LD is ${problem.chars} characters, more than the audit reads${where}.`,
        ...(moduleFix ? { fix: moduleFix } : {}),
      };
  }
}

/** Build the core check. */
export function createStructuredDataCheck(): SiteCheck {
  return {
    id: STRUCTURED_DATA_CHECK_ID,
    title: "Structured data",
    scope: "site",
    run({ pages }) {
      const findings: Finding[] = [];
      for (const page of pages) {
        // Staging answered this page's URL with another document.
        if (page.redirectedTo !== undefined) continue;
        const { blocks, moduleIds } = jsonLdBlocksOf(page);
        for (const problem of jsonLdIntegrityProblems(blocks)) {
          findings.push(findingOf(page, problem, moduleIds));
        }
      }
      return findings;
    },
  };
}
