// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { rpcToolCallId } from "./rpc-tool-call-id.js";

describe("rpcToolCallId (#1253)", () => {
  const transport = "t".repeat(43);

  it("is stable for the same call", () => {
    expect(rpcToolCallId(transport, 7)).toBe(rpcToolCallId(transport, 7));
    expect(rpcToolCallId(transport, 7)).toMatch(/^rpc-[0-9a-f]{64}$/);
  });

  it("keeps the numeric id apart from the string id", () => {
    expect(rpcToolCallId(transport, 1)).not.toBe(rpcToolCallId(transport, "1"));
  });

  it("keeps long ids that share a prefix apart (no truncation)", () => {
    const prefix = "x".repeat(200);
    expect(rpcToolCallId(transport, `${prefix}a`)).not.toBe(rpcToolCallId(transport, `${prefix}b`));
  });

  it("keeps the transport and the id apart", () => {
    expect(rpcToolCallId("a:b", "c")).not.toBe(rpcToolCallId("a", "b:c"));
  });
});
