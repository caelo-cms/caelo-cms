// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pageStatusMark } from "./state-dot.js";

describe("pageStatusMark", () => {
  it("maps the two page statuses to their own marks, never Preview/Live", () => {
    expect(pageStatusMark("draft")).toBe("draft");
    expect(pageStatusMark("published")).toBe("published");
  });

  it("fails loudly on an unknown status", () => {
    expect(() => pageStatusMark("archived")).toThrow(/unknown page status 'archived'/);
  });
});
