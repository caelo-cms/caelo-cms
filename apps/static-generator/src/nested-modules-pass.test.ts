// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ComposeModuleFailure } from "@caelo-cms/shared";
import {
  assertNoRenderFailures,
  type RenderedPageForGate,
  renderFailuresOf,
} from "./nested-modules-pass.js";

/** The gate as the build runs it: failures taken per page, refused together (#1271). */
function gate(pages: RenderedPageForGate[]): void {
  assertNoRenderFailures(pages.flatMap(renderFailuresOf));
}

function failure(reason: string, field = ""): ComposeModuleFailure {
  return {
    blockName: "content",
    moduleId: "00000000-0000-0000-0000-000000000001",
    moduleSlug: "pricing-grid",
    field,
    reason,
  };
}

describe("assertNoRenderFailures / renderFailuresOf", () => {
  it("passes clean pages", () => {
    expect(() => gate([{ pageSlug: "home", html: "<p>ok</p>", moduleFailures: [] }])).not.toThrow();
  });

  it("refuses a failure marker and names page, module and field", () => {
    expect(() =>
      gate([
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

  it("refuses a broken reference in the layout's own HTML", () => {
    expect(() =>
      gate([
        {
          pageSlug: "home",
          html: "<p>ok</p>",
          moduleFailures: [],
          layoutLinkMarkers: ["link-target-missing:page/33333333-3333-4333-8333-333333333333"],
        },
      ]),
    ).toThrow(
      'page "home" layout HTML: link-target-missing:page/33333333-3333-4333-8333-333333333333',
    );
  });

  it("refuses the recursive-renderer escape hatch", () => {
    expect(() =>
      gate([
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
      gate([
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
      gate([
        {
          pageSlug: "faq",
          html: "<section><!-- caelo:missing reason=module-list-malformed items[0] --></section>",
          moduleFailures: [],
        },
      ]),
    ).toThrow('page "faq": <!-- caelo:missing reason=module-list-malformed items[0] -->');
  });
});
