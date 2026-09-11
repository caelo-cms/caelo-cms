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
