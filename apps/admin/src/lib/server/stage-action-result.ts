// SPDX-License-Identifier: MPL-2.0

/**
 * The `staged` result both Stage form actions return (Live Edit's
 * Staging menu, Content → Changes): the build's numbers and EVERY
 * warning `describeStagedBuild` wrote, spread whole. The layout's Stage
 * toast reads the warnings from it; an action that picked fields by hand
 * dropped one (the render warning, #1604) and the operator got a plain
 * "Staged." over a build that Publish live refuses (Codex #1643).
 */

import type { describeStagedBuild } from "./stage-result.js";

/** What `describeStagedBuild` says about a finished Stage. */
export type StagedBuildDescription = Awaited<ReturnType<typeof describeStagedBuild>>;

/** The parts of a Stage's run summary the result carries. */
export interface StagedRunSummary {
  readonly pageCount: number;
  readonly fileCount: number;
  readonly buildId: string;
  readonly mergedEntityCount: number;
  readonly linkWarnings: readonly string[];
  readonly alsoIncludes: readonly { readonly title: string }[];
}

/** The `staged` object of a Stage action's result. */
export function stagedActionResult(
  summary: StagedRunSummary,
  described: StagedBuildDescription,
  scope: { readonly chatCount: number; readonly pageId: string },
) {
  return {
    ...described,
    pageId: scope.pageId,
    chatCount: scope.chatCount,
    pageCount: summary.pageCount,
    fileCount: summary.fileCount,
    buildId: summary.buildId,
    mergedEntityCount: summary.mergedEntityCount,
    linkWarnings: [...summary.linkWarnings],
    // Issue #620 — other chats' changes to the same things rode along.
    alsoIncludes: summary.alsoIncludes.map((a) => a.title),
  };
}
