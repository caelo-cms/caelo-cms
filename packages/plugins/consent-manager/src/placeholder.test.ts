// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { defaultPlaceholder } from "./placeholder.js";

describe("defaultPlaceholder", () => {
  it("offers a one-category grant for a known category", () => {
    const { html } = defaultPlaceholder("marketing", "Marketing");
    expect(html).toContain('data-consent-grant="marketing"');
    expect(html).toContain("Marketing");
  });

  it("offers no grant for an unclassified vendor", () => {
    expect(defaultPlaceholder("unclassified", null).html).not.toContain("data-consent-grant");
  });

  it("escapes the operator's category label", () => {
    expect(defaultPlaceholder("marketing", '<img src=x onerror="a()">').html).not.toContain("<img");
  });
});
