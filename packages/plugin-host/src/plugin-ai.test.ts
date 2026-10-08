// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginAiCompleteInput } from "./plugin-ai.js";

const base = { system: "s", messages: [{ role: "user", content: "hi" }] };

describe("ctx.ai.complete options (#593)", () => {
  it("accepts a declared purpose", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, purpose: "translation" }).success).toBe(true);
  });

  it("accepts a purpose the host has no setting for (it runs on the chat model)", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, purpose: "summarize" }).success).toBe(true);
  });

  it("accepts an empty message list (the SDK contract allows a system-only call)", () => {
    expect(pluginAiCompleteInput.safeParse({ system: "s", messages: [] }).success).toBe(true);
  });

  it("rejects a purpose that is not an identifier", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, purpose: "Translation!" }).success).toBe(
      false,
    );
  });

  it("rejects a plugin trying to pick the model itself", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, model: "claude-opus-5-5" }).success).toBe(
      false,
    );
  });
});
