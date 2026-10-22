// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { isWellFormedText, MAX_CLIENT_KEY_LENGTH, mcpClientKey } from "./access-token.js";

describe("mcpClientKey (#968)", () => {
  it("keys a CIMD client by its document URL", () => {
    expect(mcpClientKey("https://chatgpt.com/oauth/client.json", "ignored")).toBe(
      "https://chatgpt.com/oauth/client.json",
    );
  });

  it("keys a DCR client by its name, so a re-registration stays the same app", () => {
    expect(mcpClientKey("v2.registration-one", "Claude Code")).toBe("dcr:Claude Code");
    expect(mcpClientKey("v2.registration-two", "  Claude   Code ")).toBe("dcr:Claude Code");
  });

  it("keys an unnamed DCR client by its registration", () => {
    const a = mcpClientKey("v2.registration-one", null);
    expect(a).toMatch(/^dcr:sha256:[0-9a-f]{32}$/);
    expect(mcpClientKey("v2.registration-one", "  ")).toBe(a);
    expect(mcpClientKey("v2.registration-two", null)).not.toBe(a);
  });

  it("hashes a name with a lone surrogate, which could not be URI-encoded", () => {
    expect(mcpClientKey("v2.r", "bad \ud800")).toMatch(/^dcr:sha256:/);
    expect(isWellFormedText("ok 😀")).toBe(true);
    expect(isWellFormedText("bad \udc00")).toBe(false);
  });

  it("hashes a key that would not fit", () => {
    const longUrl = `https://claude.ai/${"x".repeat(300)}`;
    expect(mcpClientKey(longUrl, null)).toMatch(/^sha256:[0-9a-f]{32}$/);
    const long = mcpClientKey("v2.r", "n".repeat(200));
    expect(long).toMatch(/^dcr:sha256:[0-9a-f]{32}$/);
    expect(long.length).toBeLessThanOrEqual(MAX_CLIENT_KEY_LENGTH);
  });
});
