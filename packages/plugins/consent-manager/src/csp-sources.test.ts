// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginCspSourcesSchema } from "@caelo-cms/shared";
import { tagCspSources } from "./csp-sources.js";
import type { BakedTag } from "./tags.js";
import { VENDOR_TEMPLATES } from "./vendors.js";

const tag = (vendor: string, src: string, inline: string): BakedTag => ({
  name: vendor,
  vendor,
  category: "analytics",
  src,
  inline,
  position: "head",
  cookies: [],
  scope: { include: null, exclude: [], locales: null },
});

describe("tagCspSources", () => {
  it("names a vendor's hosts and the snippet's exact text", () => {
    const built = VENDOR_TEMPLATES["google-analytics"]?.build({ measurementId: "G-ABC123" });
    const sources = tagCspSources([tag("google-analytics", built?.src ?? "", built?.inline ?? "")]);
    expect(sources.origins.script).toContain("https://www.googletagmanager.com");
    expect(sources.origins.connect).toContain("https://*.google-analytics.com");
    expect(sources.inlineScripts).toEqual([built?.inline ?? ""]);
  });

  it("reads a tracker's own host out of its snippet", () => {
    const built = VENDOR_TEMPLATES.matomo?.build({
      trackerUrl: "https://analytics.example.com/",
      siteId: "1",
    });
    const sources = tagCspSources([tag("matomo", "", built?.inline ?? "")]);
    expect(sources.origins.script).toEqual(["https://analytics.example.com"]);
    expect(sources.origins.connect).toEqual(["https://analytics.example.com"]);
  });

  it("every vendor template's result passes what the build validates", () => {
    for (const [vendor, template] of Object.entries(VENDOR_TEMPLATES)) {
      const config = Object.fromEntries(
        Object.keys(template.config).map((k) => [
          k,
          k === "trackerUrl" ? "https://a.example.com/" : "1",
        ]),
      );
      const built = template.build(config);
      const sources = tagCspSources([tag(vendor, built.src, built.inline)]);
      expect(pluginCspSourcesSchema.safeParse(sources).success).toBe(true);
    }
  });

  it("text that only looks like an origin stays out, and the build does not fail on it", () => {
    const sources = tagCspSources([tag("custom", "", 'x("https://foo-.example")')]);
    expect(sources.origins.script).toEqual([]);
    expect(pluginCspSourcesSchema.safeParse(sources).success).toBe(true);
  });
});
