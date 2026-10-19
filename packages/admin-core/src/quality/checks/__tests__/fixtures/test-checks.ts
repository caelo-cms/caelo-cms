// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — a test-only findings check that proves the framework end to
 * end. Core ships no findings check (the plugins contribute them), so the
 * tests register this one the way a plugin will.
 *
 * Rule `test-meta/placeholder-description`: an error when the rendered
 * `<meta name="description">` still contains "TODO". It reads the real
 * rendered HTML of the staged build and is fixed with an SEO-only change,
 * which makes it a good probe for "an SEO-only Stage is re-checked".
 */

import { Parser } from "htmlparser2";
import type { PageCheck, StagedBuild } from "../../check.js";
import { CheckRegistry, type LighthouseRunner } from "../../registry.js";

export const PLACEHOLDER_RULE = "test-meta/placeholder-description";

/** A staged build for runner tests whose checks never probe (#849). */
export const NO_PROBE_BUILD: StagedBuild = {
  baseUrl: "http://s.test",
  probe: async (path) => {
    throw new Error(`this test's checks do not probe the build (asked for ${path})`);
  },
};

/** The `content` of every `<meta name="description">` in `<head>`. */
export function metaDescriptions(html: string): (string | null)[] {
  const found: (string | null)[] = [];
  let inBody = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "body") inBody = true;
        if (inBody || name !== "meta") return;
        if ((attrs.name ?? "").toLowerCase() !== "description") return;
        found.push(attrs.content ?? null);
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return found;
}

export const placeholderDescriptionCheck: PageCheck = {
  id: "test-meta",
  title: "Placeholder descriptions (test)",
  scope: "page",
  run: ({ page }) =>
    metaDescriptions(page.html).some((c) => c?.includes("TODO"))
      ? [
          {
            ruleId: PLACEHOLDER_RULE,
            severity: "error",
            pageId: page.pageId,
            message:
              "Placeholder meta description: the description still says TODO, so search engines show it as is.",
            fix: {
              tool: "set_page_seo_many",
              hint: "Replace the placeholder with a real description for each affected page, in one call; then Stage again.",
            },
          },
        ]
      : [],
};

/** Lighthouse plus the test check, registered as a plugin would. */
export function testCheckRegistry(lighthouse: LighthouseRunner): CheckRegistry {
  const registry = new CheckRegistry();
  registry.registerLighthouse(lighthouse);
  registry.register(placeholderDescriptionCheck, { kind: "plugin", slug: "test-plugin" });
  return registry;
}
