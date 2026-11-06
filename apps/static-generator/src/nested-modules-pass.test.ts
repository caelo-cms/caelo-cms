// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { ComposeModuleFailure } from "@caelo-cms/shared";
import {
  assertNoRenderFailures,
  type RenderedPageForGate,
  RenderFailureError,
  renderFailuresOf,
} from "./nested-modules-pass.js";

/** The gate as the build runs it: failures taken per page, refused together (#1271). */
function gate(pages: RenderedPageForGate[]): void {
  assertNoRenderFailures(
    pages.flatMap((p) => renderFailuresOf({ pageId: "p", pageTitle: "T", pagePath: "/t", ...p })),
  );
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

  it("refuses a dotted path into a field that exists: it is no copy (#1433)", () => {
    const page = (reason: string) => ({
      pageSlug: "home",
      html: '<a href="{{cta.label}}">x</a>',
      moduleFailures: [failure(reason)],
    });
    expect(() => gate([page("field-path-unknown:cta.label")])).toThrow("cta.label");
    expect(() => gate([page("field-value-empty:cta.href")])).toThrow("cta.href");
    expect(() => gate([page("field-value-malformed:cta")])).toThrow("field-value-malformed:cta");
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

  it("hands the failures over as structure, with the linked page by title (#1240)", () => {
    const target = "12004070-0000-4000-8000-000000000001";
    const page: RenderedPageForGate = {
      pageId: "p",
      pageSlug: "home-en",
      pageTitle: "Home",
      pagePath: "/en",
      html: "<p></p>",
      moduleFailures: [failure(`link-variant-missing:page/${target}:en`)],
    };
    const failures = renderFailuresOf(page, (pageId) => ({
      pageId,
      title: "Pricing",
      path: "/preise",
    }));
    expect(failures[0]).toMatchObject({
      pageId: "p",
      pageTitle: "Home",
      pagePath: "/en",
      reason: `link-variant-missing:page/${target}:en`,
      target: { pageId: target, title: "Pricing", path: "/preise" },
    });
    let thrown: unknown;
    try {
      assertNoRenderFailures(failures);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RenderFailureError);
    expect((thrown as RenderFailureError).failures).toBe(failures);
  });

  it("knows no target for a failure that is not a page link", () => {
    const failures = renderFailuresOf({
      pageId: "p",
      pageSlug: "home",
      pageTitle: "Home",
      pagePath: "/",
      html: "<p></p>",
      moduleFailures: [failure("module-missing:cards[0]")],
    });
    expect(failures[0]?.target).toBeNull();
  });
});
