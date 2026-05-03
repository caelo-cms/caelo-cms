// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { defineOperation, OperationRegistry } from "../index.js";

const noopOp = defineOperation({
  name: "test.noop",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({}),
  handler: async () => ok({}),
});

describe("OperationRegistry", () => {
  it("returns Err('UnknownOperation') for unregistered names (fail closed, not throw)", () => {
    const reg = new OperationRegistry();
    const result = reg.lookup("does.not.exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "UnknownOperation", name: "does.not.exist" });
    }
  });

  it("returns Ok(op) for a registered name", () => {
    const reg = new OperationRegistry();
    reg.register(noopOp);
    const result = reg.lookup("test.noop");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("test.noop");
  });

  it("throws when registering a duplicate name (defence against startup accidents)", () => {
    const reg = new OperationRegistry();
    reg.register(noopOp);
    expect(() => reg.register(noopOp)).toThrow(/already registered/);
  });

  it("`has` reports registration state", () => {
    const reg = new OperationRegistry();
    expect(reg.has("test.noop")).toBe(false);
    reg.register(noopOp);
    expect(reg.has("test.noop")).toBe(true);
  });

  // Avoid "unused import" lint warning; err() is exercised in other suites.
  void err;
});
