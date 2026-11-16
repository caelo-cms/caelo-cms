// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  describeRenderFailures,
  type RenderFailure,
  renderRepairOf,
  stagedRenderReport,
} from "./render-failures.js";

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
    expect(text.caeloFault?.title).toBe("The link check and the build disagreed about a link");
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
    expect(text.caeloFault).toBeNull();
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

describe("describeRenderFailures — a render without its context (#1604)", () => {
  it("is a Caelo bug of its own, not a link disagreement", () => {
    const text = describeRenderFailures([
      failure({ reason: "nested-renderer-unavailable:cards[0]" }),
      failure({}),
    ]);
    expect(text.caeloFault?.title).toBe("A build rendered content without what the renderer needs");
    expect(text.operator).toContain("This is a Caelo bug, not something in the site");
  });

  it("names each place of a page once", () => {
    const text = describeRenderFailures([failure({}), failure({}), failure({})]);
    expect(text.operator.match(/the header of Home \(\/en\)/g)).toHaveLength(1);
  });
});

describe("stagedRenderReport (#1604)", () => {
  const pathUnknown = (over: Partial<RenderFailure> = {}) =>
    failure({
      reason: "field-path-unknown:signin_link.label",
      line: 'page "home-en" module "site-header-x" (block header): field-path-unknown:signin_link.label',
      moduleSlug: "site-header-x",
      ...over,
    });

  it("is null for a build that rendered everything", () => {
    expect(stagedRenderReport([], 0)).toBeNull();
  });

  it("says the Stage succeeded, what to repair, and that Publish live is blocked", () => {
    const r = stagedRenderReport([pathUnknown(), pathUnknown({ blockName: "footer" })], 2);
    expect(r?.total).toBe(2);
    expect(r?.operatorText).toStartWith("Staged, but 2 spots could not be rendered");
    expect(r?.operatorText).toContain("the header of Home (/en)");
    expect(r?.operatorText).toContain("Publish live is blocked until they are repaired");
    expect(r?.operatorText).not.toMatch(/site-header|field-path-unknown|update_modules_many/);
    expect(r?.aiText).toContain("field-path-unknown:signin_link.label");
    expect(r?.aiText).toContain("update_modules_many");
    expect(r?.aiText).toContain("get_quality_audit");
  });

  it("counts the failures the list leaves out", () => {
    const r = stagedRenderReport([pathUnknown()], 240);
    expect(r?.total).toBe(240);
    expect(r?.aiText).toContain("could not render 240 spots");
  });

  it("reports a link like any other content: no Caelo bug on a Stage", () => {
    const r = stagedRenderReport([linkFailure()], 1);
    expect(r?.operatorText).toContain("Pricing (/preise) has no English version");
    expect(r?.operatorText).not.toContain("Caelo bug");
    expect(r?.aiText).toContain("check_links");
  });
});

describe("renderRepairOf (#1604)", () => {
  it("sends a path its link field cannot answer to the module's HTML", () => {
    const r = renderRepairOf({ reason: "field-path-unknown:cta.label", moduleSlug: "hero" });
    expect(r.tool).toBe("update_modules_many");
    expect(r.hint).toContain("{{cta.label}}");
    expect(r.hint).toContain("a link's text is a text field of its own");
  });

  it("sends a broken nested reference to the content", () => {
    const r = renderRepairOf({
      reason: "<!-- caelo:missing reason=module-missing:abc -->",
      moduleSlug: null,
    });
    expect(r.tool).toBe("set_content_instance_values_many");
  });
});
