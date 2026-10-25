// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  pluginProblemsBanner,
  previewPluginProblems,
  withPluginProblemsBanner,
} from "./plugin-problems-banner.js";

describe("plugin problems banner (#1008)", () => {
  it("adds nothing when every active plugin runs", () => {
    expect(pluginProblemsBanner([])).toBe("");
    expect(withPluginProblemsBanner("<html><body>x</body></html>", [])).toBe(
      "<html><body>x</body></html>",
    );
  });

  it("names each plugin and its reason right after <body>", () => {
    const html = withPluginProblemsBanner('<html><body class="a"><main>x</main></body></html>', [
      { slug: "international-site", reason: "[23505] duplicate key" },
    ]);
    expect(html).toStartWith('<html><body class="a"><div data-caelo-plugin-problems role="alert"');
    expect(html).toContain(
      "<strong>international-site</strong> is active but could not be loaded on this server: [23505] duplicate key",
    );
    expect(html).toContain("Publish live is blocked");
    expect(html).toContain("<main>x</main>");
  });

  it("escapes the reason (it can quote arbitrary error text)", () => {
    const banner = pluginProblemsBanner([{ slug: "forms", reason: '<img src=x onerror="a">' }]);
    expect(banner).not.toContain("<img");
    expect(banner).toContain("&#60;img src=x onerror=&#34;a&#34;&#62;");
  });

  it("prepends when the document has no <body>", () => {
    expect(withPluginProblemsBanner("<p>fragment</p>", [{ slug: "forms", reason: "x" }])).toEndWith(
      "<p>fragment</p>",
    );
  });

  it("#1087 — lists a plugin that failed during this render, with its reason", () => {
    const banner = pluginProblemsBanner(
      previewPluginProblems(
        [],
        [
          {
            slug: "international-site",
            reason: "link-resolve: international-site.link_resolve failed: OperationFailed: x",
          },
        ],
      ),
    );
    expect(banner).toContain(
      "<strong>international-site</strong> runs on this server but failed while rendering this page: link-resolve:",
    );
    expect(banner).toContain("Publish live is blocked");
  });

  it("#1087 — merges both kinds; no render failures means only the not-running list", () => {
    expect(previewPluginProblems([{ slug: "a", reason: "r" }], undefined)).toEqual([
      { slug: "a", reason: "r", kind: "not-running" },
    ]);
    expect(
      previewPluginProblems([{ slug: "a", reason: "r" }], [{ slug: "b", reason: "s" }]).map(
        (p) => p.kind,
      ),
    ).toEqual(["not-running", "render-failed"]);
  });
});
