// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1604 — the core `render` check: the content the staged build
 * could not render.
 *
 * A Stage no longer stops on such a spot. The staging build ships it as the
 * editor preview shows it (the raw `{{…}}` of a placeholder its field
 * cannot answer, a `caelo:missing` marker for a deleted nested module) and
 * its run records the failures (`deploy_runs.render_report`). This check
 * turns that record into findings, so the chat's quality panel, Fix-all and
 * `get_quality_audit` name every spot with the tool that repairs it.
 *
 * Every finding is an `error`. The gate does not need them to close:
 * Publish live reads the run's record itself (quality/gate.ts, state
 * `render`), so accepting one of these findings opens nothing. They are
 * here to be repaired.
 *
 * One defect is one finding: the same module failing the same way on
 * several pages (a header or footer on every page) is one site finding
 * that names the pages; a failure on one page belongs to that page.
 *
 * Rules: `render/<marker kind>` (`render/field-path-unknown`,
 * `render/module-missing`, `render/link-target-missing`, …), plus
 * `render/limit-reached` (info) when the run recorded more failures than
 * it lists.
 */

import { renderFailureKind, renderFailureMarker, truncateKeepingIds } from "@caelo-cms/shared";
import { type RenderFailure, renderRepairOf } from "../../deploy/render-failures.js";
import type { SiteCheck } from "./check.js";
import type { Finding } from "./findings.js";
import { MAX_FINDINGS_PER_CALL } from "./runner.js";

export const RENDER_CHECK_ID = "render";

/** What the audited run recorded of the content its build could not render. */
export interface RenderSources {
  failures(): Promise<{
    readonly failures: readonly RenderFailure[];
    /** How many there were in all (`failures` lists the first). */
    readonly total: number;
  }>;
}

/** How many pages a site finding names before "and N more". */
const PAGES_NAMED = 3;

/** Build the core render check over the audited run's record. */
export function createRenderCheck(sources: RenderSources): SiteCheck {
  return {
    id: RENDER_CHECK_ID,
    title: "Content the build could not render",
    scope: "site",
    async run({ pages }) {
      const r = await sources.failures();
      return renderFindings(r.failures, r.total, new Set(pages.map((p) => p.pageId)));
    },
  };
}

/** One place that failed, on every page it failed on. */
interface FailureGroup {
  readonly first: RenderFailure;
  readonly pages: Map<string, string>;
}

/** The place in a finding's words: the block, the module and the field. */
function placeText(f: RenderFailure): string {
  const block = f.blockName === null ? "the site layout" : `the ${f.blockName}`;
  const mod = f.moduleSlug ? `, module "${f.moduleSlug}"` : "";
  const field = f.field ? `, field "${f.field}"` : "";
  return `${block}${mod}${field}`;
}

/**
 * Map the run's failures to findings. Exported for tests.
 *
 * @param stagedPageIds the pages of the staged build; a finding names only
 *   one of them (the runner rejects the whole check otherwise), so a
 *   failure on a page published or deleted since the Stage is a site finding.
 */
export function renderFindings(
  failures: readonly RenderFailure[],
  total: number,
  stagedPageIds: ReadonlySet<string>,
): Finding[] {
  const groups = new Map<string, FailureGroup>();
  for (const f of failures) {
    const key = [f.blockName, f.moduleSlug, f.field, renderFailureMarker(f.reason)].join("|");
    const g = groups.get(key) ?? { first: f, pages: new Map<string, string>() };
    g.pages.set(f.pageId, f.pagePath);
    groups.set(key, g);
  }
  const findings: Finding[] = [];
  for (const { first, pages } of [...groups.values()].slice(0, MAX_FINDINGS_PER_CALL - 1)) {
    const only = pages.size === 1 ? [...pages.keys()][0] : undefined;
    const pageId = only !== undefined && stagedPageIds.has(only) ? only : undefined;
    const paths = [...pages.values()];
    const where =
      pageId !== undefined
        ? ""
        : ` on ${paths.length === 1 ? "page" : `${paths.length} pages`} ${paths.slice(0, PAGES_NAMED).join(", ")}${paths.length > PAGES_NAMED ? ", …" : ""}`;
    const repair = renderRepairOf(first);
    findings.push({
      ruleId: `${RENDER_CHECK_ID}/${renderFailureKind(first.reason)}`,
      severity: "error",
      ...(pageId !== undefined ? { pageId } : {}),
      message: truncateKeepingIds(
        `Could not be rendered: ${placeText(first)} (${renderFailureMarker(first.reason)})${where}. Staging shows the spot as the editor preview does, and Publish live refuses this build until it is repaired and staged again.`,
        1000,
      ),
      fix: { tool: repair.tool, hint: truncateKeepingIds(repair.hint, 500) },
    });
  }
  if (total > failures.length || groups.size > MAX_FINDINGS_PER_CALL - 1) {
    findings.push({
      ruleId: `${RENDER_CHECK_ID}/limit-reached`,
      severity: "info",
      message: `More content could not be rendered: the build recorded ${total} failure(s) and this audit lists the first. Repair the listed ones and Stage again to see the rest.`,
    });
  }
  return findings;
}
