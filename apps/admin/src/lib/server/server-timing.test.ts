// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { ServerTiming } from "./server-timing.js";

describe("ServerTiming (#1268)", () => {
  it("lists each step with its duration, as header tokens", async () => {
    const timing = new ServerTiming();
    expect(await timing.time("active page", async () => "page")).toBe("page");
    await timing.time("chat", async () => undefined);
    expect(timing.header()).toMatch(/^active_page;dur=\d+\.\d, chat;dur=\d+\.\d$/);
  });

  it("records a step that throws, and rethrows", async () => {
    const timing = new ServerTiming();
    await expect(
      timing.time("transcript", async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(timing.header()).toMatch(/^transcript;dur=/);
  });
});
