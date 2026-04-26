// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { classifySeverity, defaultTemplateBlockIsHeader } from "../snapshots/severity.js";

const TPL_A = "11111111-1111-4111-8111-111111111111";
const TPL_B = "22222222-2222-4222-8222-222222222222";
const PG = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

const isHeader = defaultTemplateBlockIsHeader;

describe("classifySeverity", () => {
  it("low: single page, body slot, single template", () => {
    const r = classifySeverity({
      affectedPages: [{ pageId: PG(1), templateId: TPL_A, blockName: "content" }],
      templateBlockIsHeader: isHeader,
    });
    expect(r.severity).toBe("low");
  });

  it("medium: 2 pages on the same template, body slot", () => {
    const r = classifySeverity({
      affectedPages: [
        { pageId: PG(1), templateId: TPL_A, blockName: "content" },
        { pageId: PG(2), templateId: TPL_A, blockName: "content" },
      ],
      templateBlockIsHeader: isHeader,
    });
    expect(r.severity).toBe("medium");
  });

  it("medium: spans 2 templates even with one page each", () => {
    const r = classifySeverity({
      affectedPages: [
        { pageId: PG(1), templateId: TPL_A, blockName: "content" },
        { pageId: PG(2), templateId: TPL_B, blockName: "content" },
      ],
      templateBlockIsHeader: isHeader,
    });
    expect(r.severity).toBe("medium");
  });

  it("high: 5+ pages affected", () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      pageId: PG(i + 1),
      templateId: TPL_A,
      blockName: "content",
    }));
    const r = classifySeverity({ affectedPages: pages, templateBlockIsHeader: isHeader });
    expect(r.severity).toBe("high");
  });

  it("high: header slot is always high regardless of page count", () => {
    const r = classifySeverity({
      affectedPages: [{ pageId: PG(1), templateId: TPL_A, blockName: "header" }],
      templateBlockIsHeader: isHeader,
    });
    expect(r.severity).toBe("high");
    expect(r.reasons.some((x) => x.includes("header"))).toBe(true);
  });

  it("low: no affected pages at all", () => {
    const r = classifySeverity({ affectedPages: [], templateBlockIsHeader: isHeader });
    expect(r.severity).toBe("low");
  });
});

describe("defaultTemplateBlockIsHeader", () => {
  it("matches common header / nav slot names", () => {
    expect(defaultTemplateBlockIsHeader("t", "header")).toBe(true);
    expect(defaultTemplateBlockIsHeader("t", "nav")).toBe(true);
    expect(defaultTemplateBlockIsHeader("t", "navigation")).toBe(true);
    expect(defaultTemplateBlockIsHeader("t", "header-mobile")).toBe(true);
    expect(defaultTemplateBlockIsHeader("t", "hero")).toBe(true);
  });

  it("does not match body / footer slots", () => {
    expect(defaultTemplateBlockIsHeader("t", "content")).toBe(false);
    expect(defaultTemplateBlockIsHeader("t", "footer")).toBe(false);
    expect(defaultTemplateBlockIsHeader("t", "sidebar")).toBe(false);
  });
});
