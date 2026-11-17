// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type StagedBuildDescription, stagedActionResult } from "./stage-action-result.js";

describe("stagedActionResult", () => {
  it("carries every warning of the description (Codex #1643: the render warning was dropped)", () => {
    const described: StagedBuildDescription = {
      previewUrl: "https://staging.example.com/",
      previewLabel: "staging.example.com",
      draftPageCount: 1,
      draftPageTitles: ["Draft"],
      unpublishedLinkWarning: "links to unpublished pages",
      truncatedListWarning: "a list was cut",
      pluginProblemWarning: "a plugin did not run",
      linkNoticeWarning: "untranslated links",
      renderWarning: "2 spots could not be rendered",
    };
    const result = stagedActionResult(
      {
        pageCount: 3,
        fileCount: 9,
        buildId: "b",
        mergedEntityCount: 4,
        linkWarnings: ["w"],
        alsoIncludes: [{ title: "Other chat" }],
      },
      described,
      { chatCount: 2, pageId: "" },
    );
    expect(result).toMatchObject(described);
    expect(result).toMatchObject({
      chatCount: 2,
      alsoIncludes: ["Other chat"],
      linkWarnings: ["w"],
    });
  });
});
