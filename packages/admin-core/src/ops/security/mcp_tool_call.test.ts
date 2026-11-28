// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { mcpCallDigest } from "./mcp_tool_call.js";

describe("mcpCallDigest (#1704)", () => {
  it("is 64 hex characters and stable for the same call", () => {
    const digest = mcpCallDigest("list_modules", { filter: "logo" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(mcpCallDigest("list_modules", { filter: "logo" })).toBe(digest);
  });

  it("tells another tool or other arguments apart", () => {
    const digest = mcpCallDigest("read_content", { entityKind: "module", entityId: "m1" });
    expect(mcpCallDigest("load_skill", { entityKind: "module", entityId: "m1" })).not.toBe(digest);
    expect(mcpCallDigest("read_content", { entityKind: "module", entityId: "m2" })).not.toBe(
      digest,
    );
    expect(mcpCallDigest("read_content", {})).not.toBe(digest);
  });

  it("does not depend on the order of object keys, at any depth", () => {
    expect(
      mcpCallDigest("update_modules_many", { items: [{ moduleId: "m", displayName: "x" }] }),
    ).toBe(mcpCallDigest("update_modules_many", { items: [{ displayName: "x", moduleId: "m" }] }));
  });

  it("keeps array order", () => {
    expect(mcpCallDigest("delete_modules_many", { moduleIds: ["a", "b"] })).not.toBe(
      mcpCallDigest("delete_modules_many", { moduleIds: ["b", "a"] }),
    );
  });
});
