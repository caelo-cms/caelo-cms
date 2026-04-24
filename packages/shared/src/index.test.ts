// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "vitest";
import { PROJECT_NAME } from "./index.js";

describe("shared scaffold", () => {
  it("exports the project name", () => {
    expect(PROJECT_NAME).toBe("caelo-cms");
  });
});
