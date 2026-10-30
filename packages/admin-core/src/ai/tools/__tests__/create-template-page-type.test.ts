// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit run 40390439183 (PR #1162): after a description rewrite the AI
 * called create_template with `pageType: "page"` and `pageType: "article"`
 * on a site whose only page type was `home`, and templates.create refused
 * both. The rewrite had framed the tool as "a template for a page type" and
 * dropped the omit rule from the routing text; no other branch's live run
 * showed the error. Same class as #1143's build_page fix: a slug is never
 * guessed. #1276 removed the omit rule (there is no default type any more):
 * the template names an existing type, or creates a new one with
 * `newPageType` in the same call.
 */

import { describe, expect, it } from "bun:test";

import { createTemplateTool } from "../create-template.js";

describe("create_template page type guidance", () => {
  it("names an existing type or a new one, and never guesses a slug (#1276)", () => {
    expect(createTemplateTool.description).toContain("Exactly one of `pageType`");
    expect(createTemplateTool.description).toContain("never guess one");
    expect(createTemplateTool.description).toContain("`list_page_types`");
    expect(createTemplateTool.description).toContain("`newPageType`");
    expect(createTemplateTool.description).not.toContain("omits `pageType`");
  });

  it("does not tell the AI to create every template with a pageType", () => {
    expect(createTemplateTool.description).not.toContain("create the template with its `pageType`");
  });
});
