// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { rpcToolCallId } from "./rpc-tool-call-id.js";

const listPages = { toolName: "list_pages", args: {} };

describe("rpcToolCallId (#1253)", () => {
  const transport = "t".repeat(43);

  it("is stable for the same call", () => {
    expect(rpcToolCallId(transport, 7, listPages)).toBe(rpcToolCallId(transport, 7, listPages));
    expect(rpcToolCallId(transport, 7, listPages)).toMatch(/^rpc-[0-9a-f]{64}$/);
  });

  it("keeps the numeric id apart from the string id", () => {
    expect(rpcToolCallId(transport, 1, listPages)).not.toBe(
      rpcToolCallId(transport, "1", listPages),
    );
  });

  it("keeps long ids that share a prefix apart (no truncation)", () => {
    const prefix = "x".repeat(200);
    expect(rpcToolCallId(transport, `${prefix}a`, listPages)).not.toBe(
      rpcToolCallId(transport, `${prefix}b`, listPages),
    );
  });

  it("keeps the transport and the id apart", () => {
    expect(rpcToolCallId("a:b", "c", listPages)).not.toBe(rpcToolCallId("a", "b:c", listPages));
  });
});

describe("rpcToolCallId names the call (#1704)", () => {
  const transport = "t".repeat(43);
  const readModule = (entityId: string) => ({
    toolName: "read_content",
    args: { entityKind: "module", entityId },
  });

  it("a reused JSON-RPC id with another tool is another key", () => {
    // The reported session: read_content under the id load_skill had used.
    expect(rpcToolCallId(transport, 12, readModule("m1"))).not.toBe(
      rpcToolCallId(transport, 12, { toolName: "load_skill", args: { slug: "brand-voice" } }),
    );
  });

  it("a reused JSON-RPC id with other arguments is another key", () => {
    expect(rpcToolCallId(transport, 12, readModule("m1"))).not.toBe(
      rpcToolCallId(transport, 12, readModule("m2")),
    );
    expect(
      rpcToolCallId(transport, 12, { toolName: "list_modules", args: { filter: "logo" } }),
    ).not.toBe(rpcToolCallId(transport, 12, { toolName: "list_modules", args: {} }));
  });

  it("a resend of the same request is the same key, whatever order its keys were serialised in", () => {
    const a = { toolName: "update_modules_many", args: { items: [{ moduleId: "m", n: 1 }] } };
    const b = { toolName: "update_modules_many", args: { items: [{ n: 1, moduleId: "m" }] } };
    expect(rpcToolCallId(transport, 3, a)).toBe(rpcToolCallId(transport, 3, b));
  });

  it("keeps array order: a reordered list is another call", () => {
    const a = { toolName: "delete_modules_many", args: { moduleIds: ["m1", "m2"] } };
    const b = { toolName: "delete_modules_many", args: { moduleIds: ["m2", "m1"] } };
    expect(rpcToolCallId(transport, 3, a)).not.toBe(rpcToolCallId(transport, 3, b));
  });
});
