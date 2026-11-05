// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeRenderFailures, type RenderFailure } from "./render-failures.js";

const TARGET = "12004070-0000-4000-8000-000000000001";

function failure(over: Partial<RenderFailure>): RenderFailure {
  return {
    pageId: "00000000-0000-4000-8000-000000000002",
    pageTitle: "Home",
    pagePath: "/en",
    blockName: "header",
    moduleSlug: "site-header-mit-mega-men-mv59jv17",
    field: null,
    reason: "module-missing:x",
    target: null,
    line: 'page "home-en" module "site-header-mit-mega-men-mv59jv17" (block header): module-missing:x',
    ...over,
  };
}

const linkFailure = (over: Partial<RenderFailure> = {}) =>
  failure({
    reason: `link-variant-missing:page/${TARGET}:en`,
    target: { pageId: TARGET, title: "Pricing", path: "/preise" },
    line: `page "home-en" module "site-header-mit-mega-men-mv59jv17" (block header): link-variant-missing:page/${TARGET}:en`,
    ...over,
  });

describe("describeRenderFailures (#1240)", () => {
  it("groups a link by its target and says it is a Caelo bug", () => {
    const text = describeRenderFailures([linkFailure(), linkFailure({ blockName: "footer" })]);
    expect(text.caeloFault).toBe(true);
    expect(text.operator).toContain(
      "Pricing (/preise) has no English version — linked from the header, the footer of /en",
    );
    expect(text.operator).toContain("This is a Caelo bug");
  });

  it("keeps slugs, ids, markers and tool names out of the operator's text", () => {
    const text = describeRenderFailures([linkFailure(), failure({})]);
    expect(text.operator).not.toContain(TARGET);
    expect(text.operator).not.toContain("site-header");
    expect(text.operator).not.toContain("link-variant-missing");
    expect(text.operator).not.toMatch(/get_content_instance|check_links|bug_report/);
  });

  it("gives the AI the technical lines and the tools", () => {
    const text = describeRenderFailures([linkFailure()]);
    expect(text.ai).toContain(`link-variant-missing:page/${TARGET}:en`);
    expect(text.ai).toContain("check_links");
    expect(text.ai).toContain("bug_report");
  });

  it("does not call a broken section a Caelo bug", () => {
    const text = describeRenderFailures([failure({})]);
    expect(text.caeloFault).toBe(false);
    expect(text.operator).toContain("the header of Home (/en) could not be rendered");
    expect(text.operator).not.toContain("Caelo bug");
  });

  it("names a link to something deleted, which has no page to name", () => {
    const text = describeRenderFailures([
      failure({ reason: `link-target-missing:page/${TARGET}`, target: null }),
    ]);
    expect(text.operator).toContain("A link points at something deleted");
    expect(text.operator).not.toContain(TARGET);
  });
});
