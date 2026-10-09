// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { combineStageClassifications, finalLinkWarnings } from "./stage-chats.js";

describe("combineStageClassifications (issue #620 multi-chat Stage)", () => {
  it("audits when any chat needs it and keeps every reason, skip and page once", () => {
    const combined = combineStageClassifications([
      {
        classification: {
          auditNeeded: false,
          reasons: [],
          skipped: ["content-only change"],
        },
        touchedPageIds: ["p1", "p2"],
      },
      {
        classification: {
          auditNeeded: true,
          reasons: [{ rule: "module_code", entityId: "m1", label: "Hero" }],
          skipped: ["content-only change"],
        },
        touchedPageIds: ["p2", "p3"],
      },
    ]);
    expect(combined.classification.auditNeeded).toBe(true);
    expect(combined.classification.reasons).toEqual([
      { rule: "module_code", entityId: "m1", label: "Hero" },
    ]);
    expect(combined.classification.skipped).toEqual(["content-only change"]);
    expect(combined.touchedPageIds).toEqual(["p1", "p2", "p3"]);
  });

  it("stays audit-free when no chat needs an audit", () => {
    const combined = combineStageClassifications([
      { classification: { auditNeeded: false, reasons: [], skipped: [] }, touchedPageIds: [] },
    ]);
    expect(combined.classification.auditNeeded).toBe(false);
    expect(combined.touchedPageIds).toEqual([]);
  });
});

describe("finalLinkWarnings (PR #622 review)", () => {
  it("reports the last merge that changed anything — earlier warnings may be fixed by later merges", () => {
    expect(
      finalLinkWarnings([
        { entityCount: 2, brokenInternalLinks: ["/pricing"] },
        { entityCount: 1, brokenInternalLinks: [] },
        { entityCount: 0, brokenInternalLinks: [] },
      ]),
    ).toEqual([]);
    expect(
      finalLinkWarnings([
        { entityCount: 1, brokenInternalLinks: [] },
        { entityCount: 1, brokenInternalLinks: ["/gone"] },
      ]),
    ).toEqual(["/gone"]);
    expect(finalLinkWarnings([{ entityCount: 0, brokenInternalLinks: [] }])).toEqual([]);
  });
});
