// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { RenderFailure } from "../../../deploy/render-failures.js";
import { findingSchema } from "../findings.js";
import { renderFindings } from "../render.js";
import { MAX_FINDINGS_PER_CALL } from "../runner.js";

const HOME = "00000000-0000-4000-8000-0000000000a1";
const PRICING = "00000000-0000-4000-8000-0000000000a2";

function failure(over: Partial<RenderFailure> = {}): RenderFailure {
  return {
    pageId: HOME,
    pageTitle: "Home",
    pagePath: "/",
    blockName: "header",
    moduleSlug: "site-header-x",
    field: null,
    reason: "field-path-unknown:signin_link.label",
    target: null,
    line: 'page "home" module "site-header-x" (block header): field-path-unknown:signin_link.label',
    ...over,
  };
}

describe("renderFindings (#1604)", () => {
  it("files a spot on one page under that page, as an error with its repair", () => {
    const f = renderFindings(
      [
        failure({
          blockName: "content",
          moduleSlug: "hero",
          reason: "field-path-unknown:cta.label",
        }),
      ],
      1,
      new Set([HOME]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      ruleId: "render/field-path-unknown",
      severity: "error",
      pageId: HOME,
      fix: { tool: "update_modules_many" },
    });
    expect(f[0]?.message).toStartWith('Could not be rendered: the content, module "hero"');
    expect(f[0]?.message).toContain("Publish live refuses this build");
    for (const x of f) expect(findingSchema.safeParse(x).success).toBe(true);
  });

  it("makes the same module failing on several pages one site finding naming them", () => {
    const f = renderFindings(
      [failure(), failure({ pageId: PRICING, pagePath: "/pricing" })],
      2,
      new Set([HOME, PRICING]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.pageId).toBeUndefined();
    expect(f[0]?.message).toContain("on 2 pages /, /pricing");
  });

  it("keeps a failure on a page that is no longer staged site-wide", () => {
    const f = renderFindings([failure()], 1, new Set([PRICING]));
    expect(f[0]?.pageId).toBeUndefined();
    expect(f[0]?.message).toContain("on page /");
  });

  it("names the marker inside a backstop comment and sends it to the content", () => {
    const f = renderFindings(
      [failure({ reason: "<!-- caelo:missing reason=module-missing:abc -->", moduleSlug: null })],
      1,
      new Set([HOME]),
    );
    expect(f[0]?.ruleId).toBe("render/module-missing");
    expect(f[0]?.fix?.tool).toBe("set_content_instance_values_many");
  });

  it("says when the run recorded more than it lists", () => {
    const f = renderFindings([failure()], 240, new Set([HOME]));
    expect(f.at(-1)).toMatchObject({ ruleId: "render/limit-reached", severity: "info" });
  });

  it("stays within one call's finding limit", () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_CALL + 20 }, (_, i) =>
      failure({ moduleSlug: `m-${i}` }),
    );
    const f = renderFindings(many, many.length, new Set([HOME]));
    expect(f.length).toBeLessThanOrEqual(MAX_FINDINGS_PER_CALL);
    expect(f.at(-1)?.ruleId).toBe("render/limit-reached");
  });

  it("reports nothing for a build that rendered everything", () => {
    expect(renderFindings([], 0, new Set([HOME]))).toEqual([]);
  });
});
