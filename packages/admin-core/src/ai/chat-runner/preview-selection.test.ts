// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { chatSendMessageInput } from "@caelo-cms/shared";
import { buildUserContent } from "./persistence.js";

test("the provider and persisted history receive the selected plugin revision and element", () => {
  const selection = {
    pluginSlug: "example",
    id: "text-one",
    label: "Page 1 · Text",
    reference: { revisionId: crypto.randomUUID(), pageId: crypto.randomUUID(), part: "text" },
  };
  const input = chatSendMessageInput.parse({
    chatSessionId: crypto.randomUUID(),
    content: "Shorten this",
    previewSelection: selection,
  });
  const text = buildUserContent(input);
  expect(text).toContain("Shorten this");
  expect(JSON.parse(text.slice(text.lastIndexOf("\n") + 1))).toEqual(selection);
  expect(text).toContain("verify the current revision");
  expect(text).not.toContain("module=");
});
