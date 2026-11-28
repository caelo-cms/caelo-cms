// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { idsInArgs } from "./plugin-approval-staleness.js";

const MODULE = "96F18E17-0000-4000-8000-000000001705";

describe("idsInArgs (#1705)", () => {
  it("takes the ids among a call's top-level arguments and arrays of them, lowercased", () => {
    expect(
      idsInArgs({
        moduleId: MODULE,
        moduleSlug: "tool-google-anmeldung-21",
        hosts: ["accounts.google.com", "00000000-0000-4000-8000-000000000002"],
        reason: "Sends nothing before the visitor signs in",
      }),
    ).toEqual([MODULE.toLowerCase(), "00000000-0000-4000-8000-000000000002"]);
  });

  it("names nothing for a call without ids, so its card is not held up", () => {
    expect(idsInArgs({ slug: "x", n: 3 })).toEqual([]);
    expect(idsInArgs(null)).toEqual([]);
    expect(idsInArgs("00000000-0000-4000-8000-000000000002")).toEqual([]);
  });

  it("dedupes and stays within the read's bound", () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(idsInArgs({ a: many, b: many[0] })).toHaveLength(50);
  });
});
