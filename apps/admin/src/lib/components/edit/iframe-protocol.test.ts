// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type FieldEditMessage, previewMessage } from "./iframe-protocol.js";

const EDITOR = "https://admin.example.com";
// Stand-ins for window objects: the check is identity, not shape.
const preview = {} as Window;
const otherFrame = {} as Window;
const fieldEdit: FieldEditMessage = {
  kind: "caelo:field-edit",
  pageId: "p",
  blockName: "content",
  position: 0,
  field: "hero_title",
  text: "Hello",
};

describe("previewMessage (PR #931 review)", () => {
  it("accepts a Caelo message from the preview on the editor's origin", () => {
    expect(
      previewMessage({ source: preview, origin: EDITOR, data: fieldEdit }, preview, EDITOR),
    ).toEqual(fieldEdit);
  });

  it("rejects an external page the preview navigated to", () => {
    // After following an external link the foreign page IS the iframe's
    // contentWindow; only its origin gives it away. It must not be able to
    // trigger a save with the operator's CSRF token.
    expect(
      previewMessage(
        { source: preview, origin: "https://evil.example", data: fieldEdit },
        preview,
        EDITOR,
      ),
    ).toBeNull();
    expect(
      previewMessage({ source: preview, origin: "null", data: fieldEdit }, preview, EDITOR),
    ).toBeNull();
  });

  it("rejects other windows, a missing preview and non-Caelo data", () => {
    expect(
      previewMessage({ source: otherFrame, origin: EDITOR, data: fieldEdit }, preview, EDITOR),
    ).toBeNull();
    expect(
      previewMessage({ source: null, origin: EDITOR, data: fieldEdit }, null, EDITOR),
    ).toBeNull();
    expect(
      previewMessage({ source: preview, origin: EDITOR, data: { kind: "other" } }, preview, EDITOR),
    ).toBeNull();
  });
});
