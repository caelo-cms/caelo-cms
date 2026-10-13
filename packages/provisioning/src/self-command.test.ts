// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { selfCommand } from "./self-command.js";

describe("selfCommand", () => {
  it("pins every printed command to the running CLI's release (#696)", () => {
    expect(selfCommand()).toBe(`bunx @caelo-cms/provisioning@${CAELO_VERSION}`);
    expect(selfCommand("rotate-secret", "internal-secret", "--install", "example.com")).toBe(
      `bunx @caelo-cms/provisioning@${CAELO_VERSION} rotate-secret internal-secret --install example.com`,
    );
  });
});
