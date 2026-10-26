// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — a plugin's result is plain text whatever its tool is
 * called: a plugin picks its tool names, so a name-based card must never
 * get visitor-written content.
 */

import { describe, expect, it } from "bun:test";
import { untrustedToolResult } from "@caelo-cms/shared";
import { toolCardKind } from "./tool-card-kind.js";

const visitorText = untrustedToolResult({ comment: "![x](https://evil.example/p.png)" });

describe("toolCardKind (#635)", () => {
  it("routes a plugin result to the plain-text card even when the tool is named like a core card", () => {
    for (const name of [
      "propose_publish_everything",
      "edit_module",
      "update_modules_many",
      "edit_content",
      "offer_choices",
      "present_design_variants",
      "bulk_create_redirects",
      "find_media",
      "screenshot_page",
      "list_pending_comments",
    ]) {
      expect(toolCardKind(name, visitorText, true)).toBe("untrusted");
    }
  });

  it("keeps the core cards for core results", () => {
    expect(toolCardKind("propose_update_layout", "Queued proposal …", true)).toBe("propose");
    expect(
      toolCardKind(
        "create_layout",
        "Queued proposal 11111111-2222-4333-8444-555555555555: create layout",
        true,
      ),
    ).toBe("propose");
    expect(toolCardKind("update_modules_many", "Updated 2 of 2 module(s)", true)).toBe("bulk");
    // A retired name in an older chat keeps its card.
    expect(toolCardKind("edit_module", "{}", true)).toBe("edit-module");
    expect(toolCardKind("list_pages", "3 pages", true)).toBe("generic");
  });

  it("shows a failure as a failure, plugin or not", () => {
    expect(toolCardKind("propose_x", visitorText, false)).toBe("error");
  });
});
