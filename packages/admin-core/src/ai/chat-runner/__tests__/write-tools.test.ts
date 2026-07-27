// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (redesign) — the DETECT layer's classifier.
 *
 * The narrate-then-stop guard fires only when a turn engaged the task with
 * read/meta tools and then stopped without writing, so a misclassification in
 * either direction breaks it: calling a write "read/meta" would fire the guard
 * after real work, and calling `load_skill` a write would suppress it in
 * exactly the scenario it exists for (skill-engaged turns, where `load_skill`
 * occupies the first loop).
 */

import { describe, expect, it } from "bun:test";

import { isReadOrMetaTool, isWriteTool } from "../write-tools.js";

describe("isReadOrMetaTool", () => {
  it("classifies the read/meta catalogue by prefix", () => {
    for (const name of [
      "list_pages",
      "get_theme",
      "read_content",
      "find_media",
      "grep_content",
      "query_page_html",
      "inspect_page_render",
      "inspect_external_page",
      "screenshot_page",
      "check_page_content_inventory",
      "map_external_page_types",
      "detect_import_boilerplate",
    ]) {
      expect(isReadOrMetaTool(name)).toBe(true);
    }
  });

  it("classifies load_skill as meta — the whole point of the redesign", () => {
    // Progressive-disclosure skills made `load_skill` consume the first loop of
    // every skill-engaged turn. Treating it as work is what silently disabled
    // the old loop-0 guard from 2026-07-19 on.
    expect(isReadOrMetaTool("load_skill")).toBe(true);
    expect(isWriteTool("load_skill")).toBe(false);
  });

  it("treats read_page_more as meta (paging, not a mutation)", () => {
    expect(isReadOrMetaTool("read_page_more")).toBe(true);
  });
});

describe("isWriteTool", () => {
  it("counts real mutations as work", () => {
    for (const name of [
      "build_page",
      "edit_module",
      "update_modules_many",
      "add_module",
      "add_module_to_layout",
      "set_page_module_content",
      "import_media_from_urls",
      "set_theme_tokens",
      "edit_content",
    ]) {
      expect(isWriteTool(name)).toBe(true);
    }
  });

  it("counts offer_choices as work so asking the operator suppresses the guard", () => {
    // Handing control back is a legitimate end of a turn — the guard must not
    // treat it as "engaged but never acted".
    expect(isWriteTool("offer_choices")).toBe(true);
  });

  it("defaults an unknown tool to write (safe direction)", () => {
    // A new tool is consequential until someone deliberately allowlists it:
    // over-counting work only declines a recovery, under-counting would fire
    // the guard after real changes.
    expect(isWriteTool("some_tool_shipped_next_week")).toBe(true);
  });

  it("does not match a read prefix appearing mid-name", () => {
    expect(isWriteTool("bulk_get_something")).toBe(true);
  });
});
