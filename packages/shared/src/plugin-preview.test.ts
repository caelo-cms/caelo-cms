// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { chatSendMessageInput } from "./ai-tools.js";
import {
  PLUGIN_PREVIEW_REFERENCE_MARKER,
  pluginPreviewDocumentSchema,
  pluginPreviewSelectionSchema,
  readPluginPreviewReference,
} from "./plugin-preview.js";

test("bounded plugin selections retain exact revision and target identity through chat input", () => {
  const selection = {
    pluginSlug: "example",
    id: "page-one-text",
    label: "Page 1 · Text",
    reference: {
      documentId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      pageId: crypto.randomUUID(),
      part: "text",
    },
  };
  const parsed = chatSendMessageInput.parse({
    chatSessionId: crypto.randomUUID(),
    content: "Make this shorter",
    previewSelection: selection,
  });
  expect(parsed.previewSelection).toEqual(selection);
  expect(
    pluginPreviewSelectionSchema.safeParse({ ...selection, reference: { html: "x".repeat(257) } })
      .success,
  ).toBe(false);
  expect(
    pluginPreviewSelectionSchema.safeParse({ ...selection, pluginSlug: "../admin" }).success,
  ).toBe(false);
  const target = { id: "one", label: "One", reference: { id: "one" } };
  expect(
    pluginPreviewDocumentSchema.safeParse({ html: "<p>One</p>", targets: [target, target] })
      .success,
  ).toBe(false);
});

test("transcripts show a reference label without exposing opaque IDs or losing ordinary text", () => {
  const selection = {
    id: "text",
    label: "Page 1 · Text",
    pluginSlug: "example",
    reference: { revisionId: "private-revision", part: "text" },
  };
  expect(
    readPluginPreviewReference(
      "Shorten this" + PLUGIN_PREVIEW_REFERENCE_MARKER + JSON.stringify(selection),
    ),
  ).toEqual({ text: "Shorten this", selection });
  const literal = "Unrelated message" + PLUGIN_PREVIEW_REFERENCE_MARKER + "not JSON";
  expect(readPluginPreviewReference(literal)).toEqual({ text: literal });
});

test("viewport context must reference declared targets and document choices have unique identities", () => {
  const target = { id: "page", label: "Page", reference: { revisionId: "one" } };
  expect(
    pluginPreviewDocumentSchema.safeParse({
      html: "",
      targets: [target],
      contextTargetIds: ["missing"],
    }).success,
  ).toBe(false);
  expect(
    pluginPreviewDocumentSchema.safeParse({
      html: "",
      targets: [target],
      contextTargetIds: ["page"],
    }).success,
  ).toBe(true);
  const doc = { id: "document", label: "Document", url: "/plugins/example/preview?args=%7B%7D" };
  expect(pluginPreviewDocumentSchema.safeParse({ html: "", documents: [doc, doc] }).success).toBe(
    false,
  );
});
