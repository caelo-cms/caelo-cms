// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { modelForPurpose } from "./model-purpose.js";

describe("modelForPurpose (#593 resolution order)", () => {
  it("uses the stored translation model for purpose=translation", () => {
    expect(modelForPurpose("translation", { translationModel: "claude-haiku-4-5" })).toBe(
      "claude-haiku-4-5",
    );
  });

  it("inherits the chat model when no translation model is stored (NULL)", () => {
    expect(modelForPurpose("translation", { translationModel: null })).toBeNull();
  });

  it("inherits the chat model for a call without a purpose", () => {
    expect(modelForPurpose(undefined, { translationModel: "claude-haiku-4-5" })).toBeNull();
  });

  it("inherits the chat model for a purpose the host has no setting for", () => {
    expect(modelForPurpose("summarize", { translationModel: "claude-haiku-4-5" })).toBeNull();
  });
});
