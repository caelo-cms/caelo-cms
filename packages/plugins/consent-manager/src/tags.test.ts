// SPDX-License-Identifier: MPL-2.0

/**
 * Tag embedding (#456 review): the runtime is inlined into every page
 * as one <script>, so tag data must never be able to end that element,
 * and a vendor's HTML snippet must be rejected rather than stored as
 * JavaScript that throws on every page view.
 */

import { describe, expect, it } from "bun:test";
import { assertInlineSnippetIsJs, buildTagInjector, jsonForInlineScript } from "./tags.js";

const META_EVENTS_MANAGER =
  "<script>!function(f,b,e,v){/* fbq bootstrap */}(window,document,'script');fbq('init','123');</script>" +
  '<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=123&ev=PageView"/></noscript>';

describe("jsonForInlineScript", () => {
  it("cannot close the surrounding <script>", () => {
    const out = jsonForInlineScript({ inline: "a</script><img src=x onerror=alert(1)>" });
    expect(out).not.toContain("</");
    expect(JSON.parse(out)).toEqual({ inline: "a</script><img src=x onerror=alert(1)>" });
  });

  it("escapes the JS line separators", () => {
    expect(jsonForInlineScript("a b c")).toBe('"a\\u2028b\\u2029c"');
  });
});

describe("buildTagInjector", () => {
  it("keeps tag data from terminating the inline runtime", () => {
    const js = buildTagInjector([
      { name: "t", category: "marketing", position: "body_end", src: "", inline: "x='</script>';" },
    ]);
    expect(js).not.toContain("</script>");
  });
});

describe("assertInlineSnippetIsJs", () => {
  it("rejects the snippet exactly as Meta's Events Manager hands it out", () => {
    expect(() => assertInlineSnippetIsJs(META_EVENTS_MANAGER)).toThrow(
      /INSIDE the vendor's <script>/,
    );
  });

  it("accepts the JavaScript between the tags", () => {
    expect(() =>
      assertInlineSnippetIsJs("fbq('init','123');fbq('track','PageView');"),
    ).not.toThrow();
  });
});
