// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { ok } from "@caelo/shared";
import { z } from "zod";
import { defineOperation } from "../index.js";

describe("defineOperation", () => {
  it("preserves the input/output Zod schemas on the returned definition", () => {
    const op = defineOperation({
      name: "test.echo",
      actorScope: ["human", "system"],
      database: "cms_admin",
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string() }),
      handler: async (_ctx, input) => ok({ echoed: input.message }),
    });

    // Input schema rejects wrong shape.
    const badInput = op.input.safeParse({ message: 123 });
    expect(badInput.success).toBe(false);

    // Input schema accepts valid shape.
    const goodInput = op.input.safeParse({ message: "hi" });
    expect(goodInput.success).toBe(true);

    expect(op.name).toBe("test.echo");
    expect(op.actorScope).toEqual(["human", "system"]);
    expect(op.database).toBe("cms_admin");
  });
});
