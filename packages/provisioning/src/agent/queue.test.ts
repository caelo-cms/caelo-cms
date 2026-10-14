// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { loadAgentQueueOpener } from "./queue.js";

describe("loadAgentQueueOpener", () => {
  it("finds the agent's database module (the bundle, or the workspace package)", async () => {
    expect(typeof (await loadAgentQueueOpener())).toBe("function");
  });
});
