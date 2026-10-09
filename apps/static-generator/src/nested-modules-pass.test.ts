// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ComposeModuleFailure } from "@caelo-cms/shared";
import { assertNoRenderFailures } from "./nested-modules-pass.js";

function failure(reason: string, field = ""): ComposeModuleFailure {
  return {
    blockName: "content",
    moduleId: "00000000-0000-0000-0000-000000000001",
    moduleSlug: "pricing-grid",
    field,
    reason,
  };
}

describe("assertNoRenderFailures", () => {
  it("passes clean pages", () => {
    expect(() =>
      assertNoRenderFailures([{ pageSlug: "home", html: "<p>ok</p>", moduleFailures: [] }]),
    ).not.toThrow();
  });

  it("refuses a failure marker and names page, module and field", () => {
    expect(() =>
      assertNoRenderFailures([
        {
          pageSlug: "pricing",
          html: "<!-- caelo:missing reason=content-instance-missing x -->",
          moduleFailures: [failure("content-instance-missing:x", "plans[1]")],
        },
      ]),
    ).toThrow(
      'page "pricing" module "pricing-grid" (block content) field "plans[1]": content-instance-missing:x',
    );
  });

  it("refuses the recursive-renderer escape hatch", () => {
    expect(() =>
      assertNoRenderFailures([
        {
          pageSlug: "home",
          html: "<!-- caelo:module-list cards needs recursive renderer (compose path) -->",
          moduleFailures: [failure("nested-renderer-unavailable:cards[0]")],
        },
      ]),
    ).toThrow("nested-renderer-unavailable:cards[0]");
  });

  it("leaves loud-raw placeholders to the editor surface (visible, and can be real copy)", () => {
    expect(() =>
      assertNoRenderFailures([
        {
          pageSlug: "docs",
          html: "<code>{{theme_logo_url}}</code>",
          moduleFailures: [
            failure("field-not-declared:example"),
            failure("theme-asset-unbound:logo"),
          ],
        },
      ]),
    ).not.toThrow();
  });

  it("catches a marker comment that bypassed the structured channel", () => {
    expect(() =>
      assertNoRenderFailures([
        {
          pageSlug: "faq",
          html: "<section><!-- caelo:missing reason=module-list-malformed items[0] --></section>",
          moduleFailures: [],
        },
      ]),
    ).toThrow('page "faq": <!-- caelo:missing reason=module-list-malformed items[0] -->');
  });
});
