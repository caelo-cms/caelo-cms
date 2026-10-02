// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import { pluginWorkflowSuggestions } from "./plugin-workflows.js";

test("workflow entries require both a loaded plugin and a currently visible skill", () => {
  const visible = [
    { slug: "book-authoring", displayName: "Picture books" },
    { slug: "standalone", displayName: "Standalone instruction" },
  ];
  expect(pluginWorkflowSuggestions(visible, new Set(["book-authoring", "revoked-guide"]))).toEqual([
    {
      label: "Picture books",
      message:
        "I'd like to get started with Picture books. Please guide me through this workflow and ask about what I want to create.",
    },
  ]);
  expect(pluginWorkflowSuggestions([], new Set(["book-authoring"]))).toEqual([]);
  expect(pluginWorkflowSuggestions(visible, new Set())).toEqual([]);
});

test("a just-activated workflow is shown even when more than eight exist", () => {
  const older = Array.from({ length: 10 }, (_, i) => ({
    slug: `a-${i}`,
    displayName: `Older ${i}`,
    activatedAt: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
  }));
  const newest = { slug: "z-new", displayName: "Newest", activatedAt: "2026-09-30T00:00:00Z" };
  const slugs = new Set([...older, newest].map((s) => s.slug));
  const shown = pluginWorkflowSuggestions([...older, newest], slugs).map((s) => s.label);
  expect(shown).toHaveLength(8);
  expect(shown[0]).toBe("Newest");
});
