// SPDX-License-Identifier: MPL-2.0

/**
 * e2e-livedit run 40390439183 (PR #1162): after a description rewrite the AI
 * called create_template with `pageType: "page"` and `pageType: "article"`
 * on a site whose only page type was `home`, and templates.create refused
 * both. The rewrite had framed the tool as "a template for a page type" and
 * dropped the omit rule from the routing text; no other branch's live run
 * showed the error. Same class as #1143's build_page fix: an ordinary
 * template omits the type, and a slug is never guessed.
 */

import { describe, expect, it } from "bun:test";

import { createTemplateTool } from "../create-template.js";

describe("create_template page type guidance", () => {
  it("tells the AI to omit pageType for an ordinary template and never guess a slug", () => {
    expect(createTemplateTool.description).toContain("An ordinary template omits `pageType`");
    expect(createTemplateTool.description).toContain("never guess one");
    expect(createTemplateTool.description).toContain("`list_page_types`");
  });

  it("does not tell the AI to create every template with a pageType", () => {
    expect(createTemplateTool.description).not.toContain("create the template with its `pageType`");
  });
});
